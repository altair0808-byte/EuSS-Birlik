const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx'); // для ЧТЕНИЯ загружаемых файлов — заметно терпимее ExcelJS
                               // к файлам, созданным не Microsoft Excel (LibreOffice, Google
                               // Таблицы, openpyxl/Python-выгрузки из 1С и т.п.). Бланк для
                               // скачивания по-прежнему генерируется через ExcelJS ниже.
const { query, pool } = require('../db');
const { authRequired, requireRole } = require('./auth');
const { makeUploader } = require('../upload');
const { buildHistoricalFields } = require('./assignments');
const { computeFioFields, transliterate } = require('../lib/fio');

// Ищет уже существующего сотрудника с таким же ФИО (без учёта регистра/пробелов) —
// п.9 запроса: "УТЯШЕВ АЛТАИР" / "утяшев алтаир" / "Утяшев Алтаир" — одна запись.
// excludeId — id сотрудника, которого не нужно считать дублем самого себя (при редактировании).
async function findDuplicateEmployee(lastName, firstName, excludeId) {
  const { normalized } = computeFioFields(lastName, firstName);
  if (!normalized) return null;
  const params = [normalized];
  let sql = `SELECT id, last_name, first_name, object, department, position, active
             FROM users WHERE role = 'employee' AND full_name_normalized = $1`;
  if (excludeId) { params.push(excludeId); sql += ` AND id != $${params.length}`; }
  sql += ' LIMIT 1';
  const res = await query(sql, params);
  return res.rows[0] || null;
}

const upload = makeUploader('imports');

// List users (суперадмин скрыт из списка)
router.get('/', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { object, department, q } = req.query;
    // Администраторы не входят в список сотрудников и статистику: по умолчанию отдаём только
    // сотрудников. Список администраторов (?role=admin) — вкладка «Администраторы», только суперадмин.
    const role = req.query.role === 'admin' ? 'admin' : 'employee';
    if (role === 'admin' && req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'forbidden_role', message: 'Список администраторов доступен только суперадмину' });
    }
    // Кадровый статус: по умолчанию отдаём только действующих сотрудников (employment_status='active'),
    // как и раньше — уволенные/в декрете не должны неожиданно появляться в общем списке и статистике.
    // ?status=archive — вкладка «Архив» (уволены / в декрете). ?status=all — вообще без фильтра.
    const statusFilter = req.query.status === 'archive' ? 'archive' : (req.query.status === 'all' ? 'all' : 'active');
    let sql = `SELECT id, last_name, first_name, object, department, position, login, role, active,
                      employment_status, status_date, created_at, permanent_certificate_number, tco_badge
               FROM users WHERE role = $1`;
    const params = [role];
    if (statusFilter === 'active') sql += ` AND employment_status = 'active'`;
    else if (statusFilter === 'archive') sql += ` AND employment_status IN ('fired', 'maternity')`;
    if (object) { params.push(object); sql += ` AND object = $${params.length}`; }
    if (department) { params.push(department); sql += ` AND department = $${params.length}`; }
    if (q) {
      // Поиск одновременно по русскому написанию и по английской транслитерации
      // (п.9 запроса): "Утяшев", "Altair", "Utyashev", "Алтаир" должны находить
      // одного и того же сотрудника — сравниваем и с обычными полями, и с
      // full_name_translit (латинская транслитерация ФИО).
      params.push(`%${q}%`);
      sql += ` AND (last_name ILIKE $${params.length} OR first_name ILIKE $${params.length}
                     OR login ILIKE $${params.length} OR full_name_translit ILIKE $${params.length}
                     OR full_name_normalized ILIKE $${params.length})`;
    }
    sql += ' ORDER BY last_name, first_name';
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (e) {
    console.error('Error fetching users:', e);
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Bulk import from Excel
// Обязательные колонки (шапка, порядок любой): Фамилия, Имя
// Опционально: Объект, Отдел, Должность, Логин, Пароль
// Если Логин не указан — сотрудник создаётся без доступа в систему,
// логин и пароль можно назначить позже через карточку профиля (кнопка "Изменить").
// Опционально (чтобы сразу зафиксировать уже пройденное ранее обучение —
// например, из старого бумажного/Excel-журнала — вместе с созданием сотрудника):
// Курс, № протокола, Дата протокола, Дата прохождения, № сертификата, Действителен до, Результат %
router.post('/import', authRequired, requireRole('admin', 'superadmin'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });

  const originalName = String(req.file.originalname || '').toLowerCase();
  if (!originalName.endsWith('.xlsx')) {
    return res.status(400).json({
      error: 'invalid_format',
      message: 'Поддерживается только формат .xlsx. Откройте файл в Excel и сохраните его как "Книга Excel (.xlsx)", затем загрузите снова.'
    });
  }

  const headerMap = {
    'фамилия': 'last_name',
    'имя': 'first_name',
    'объект': 'object',
    'отдел': 'department',
    'подразделение': 'department',
    'должность': 'position',
    'логин': 'login',
    'табельный номер': 'login',
    'пароль': 'password',
    'курс': 'course',
    'название курса': 'course',
    'номер протокола': 'protocol_number',
    '№ протокола': 'protocol_number',
    'дата протокола': 'protocol_date',
    'дата прохождения': 'test_date',
    'дата тестирования': 'test_date',
    'номер сертификата': 'certificate_number',
    '№ сертификата': 'certificate_number',
    'действителен до': 'next_test_date',
    'дата след. прохождения': 'next_test_date',
    'результат %': 'score_percent',
    'балл': 'score_percent',
    '№ пропуска тшо': 'tco_badge',
    'пропуск тшо': 'tco_badge',
    'tco badge': 'tco_badge'
  };

  // Excel хранит даты как объекты Date — приводим к формату YYYY-MM-DD,
  // как их вводят вручную в форме "Назначить тест" (input type="date"),
  // чтобы даты выглядели одинаково независимо от способа ввода.
  function cellToDateStr(cellValue) {
    if (!cellValue) return '';
    if (cellValue instanceof Date) {
      const y = cellValue.getUTCFullYear();
      const m = String(cellValue.getUTCMonth() + 1).padStart(2, '0');
      const d = String(cellValue.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    return String(cellValue).trim();
  }

  let sheetRows; // массив строк-массивов, sheetRows[0] — шапка
  try {
    const wb = XLSX.readFile(req.file.path, { cellDates: true, raw: true });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return res.status(400).json({ error: 'empty_file', message: 'В файле нет ни одного листа с данными.' });
    const ws = wb.Sheets[sheetName];
    sheetRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
  } catch (readErr) {
    console.error('Error reading import file:', readErr);
    return res.status(400).json({
      error: 'invalid_file',
      message: 'Не удалось прочитать файл. Убедитесь, что это корректный Excel-файл (.xlsx), он не повреждён и не защищён паролем.'
    });
  }

  try {
    if (!sheetRows.length) return res.status(400).json({ error: 'empty_file', message: 'В файле нет ни одного листа с данными.' });

    const headerRow = sheetRows[0];
    const colByField = {}; // field -> индекс колонки (0-based)
    headerRow.forEach((cellValue, colIndex) => {
      const key = String(cellValue || '').trim().toLowerCase();
      if (headerMap[key] && !(headerMap[key] in colByField)) colByField[headerMap[key]] = colIndex;
    });
    if (!(colByField.last_name >= 0) || !(colByField.first_name >= 0)) {
      return res.status(400).json({ error: 'missing_columns', message: 'В файле должны быть колонки: Фамилия, Имя (и опционально Объект, Отдел, Должность, Логин, Пароль)' });
    }

    const DATE_FIELDS = new Set(['protocol_date', 'test_date', 'next_test_date']);
    let created = 0, skipped = 0, historyCreated = 0;
    const errors = [];

    for (let r = 1; r < sheetRows.length; r++) {
      const row = sheetRows[r];
      const rowNum = r + 1; // номер строки как в Excel (шапка = строка 1)
      const get = (field) => {
        if (!(field in colByField)) return '';
        const raw = row[colByField[field]];
        return DATE_FIELDS.has(field) ? cellToDateStr(raw) : String(raw ?? '').trim();
      };
      const last_name = get('last_name');
      const first_name = get('first_name');
      const login = get('login') || null; // логин необязателен — можно назначить позже в карточке профиля
      if (!last_name && !first_name && !login) continue; // blank row

      if (!last_name || !first_name) {
        errors.push(`Строка ${rowNum}: не заполнены обязательные поля (Фамилия, Имя)`);
        skipped++;
        continue;
      }

      try {
        if (login) {
          const exists = await query('SELECT id FROM users WHERE login = $1', [login]);
          if (exists.rows.length > 0) {
            errors.push(`Строка ${rowNum}: логин "${login}" уже занят`);
            skipped++;
            continue;
          }
        }

        // Защита от дублей (п.9 запроса): если сотрудник с таким ФИО (без учёта
        // регистра/пробелов, "УТЯШЕВ АЛТАИР" = "Утяшев Алтаир") уже есть в системе,
        // новая запись не создаётся — используется существующий сотрудник, и к нему
        // же, если указано, привязывается историческая запись об обучении из строки.
        const dup = await findDuplicateEmployee(last_name, first_name);
        let userId;
        if (dup) {
          userId = dup.id;
          errors.push(`Строка ${rowNum}: сотрудник "${last_name} ${first_name}" уже есть в системе — новая карточка не создана, используется существующая`);
          skipped++;
        } else {
          // Пароль/хэш нужны только если указан логин — без логина сотрудник
          // просто числится в списке и не может войти в систему до тех пор,
          // пока ему не назначат логин и пароль через карточку профиля.
          const password = login ? (get('password') || Math.random().toString(36).slice(-8)) : null;
          const hash = password ? bcrypt.hashSync(password, 10) : null;
          const { normalized, translit } = computeFioFields(last_name, first_name);
          const userResult = await query(
            `INSERT INTO users (last_name, first_name, object, department, position, login, password_hash, role, tco_badge, full_name_normalized, full_name_translit)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'employee', $8, $9, $10) RETURNING id`,
            [last_name, first_name, get('object'), get('department'), get('position'), login, hash, get('tco_badge') || null, normalized, translit]
          );
          userId = userResult.rows[0].id;
          created++;
        }

        // Если в строке указан курс — параллельно заносим уже пройденное ранее
        // обучение (протокол + сертификат) как историческую запись, чтобы не
        // вбивать её вручную по каждому сотруднику после импорта.
        const courseTitle = get('course');
        if (courseTitle) {
          const protocol_number = get('protocol_number');
          const protocol_date = get('protocol_date');
          const test_date = get('test_date');

          if (!protocol_number || !protocol_date || !test_date) {
            errors.push(`Строка ${rowNum}: сотрудник создан, но обучение не внесено — для курса "${courseTitle}" нужны № протокола, дата протокола и дата прохождения`);
            continue;
          }

          const cRes = await query(
            `SELECT id FROM courses WHERE lower(title_ru) = lower($1) OR lower(title_kz) = lower($1) LIMIT 1`,
            [courseTitle]
          );
          const course = cRes.rows[0];
          if (!course) {
            errors.push(`Строка ${rowNum}: курс "${courseTitle}" не найден — обучение не внесено`);
            continue;
          }

          try {
            const h = await buildHistoricalFields(course.id, {
              test_date,
              next_test_date: get('next_test_date'),
              certificate_number: get('certificate_number'),
              score_percent: get('score_percent')
            });
            await query(`
              INSERT INTO assignments (user_id, course_id, protocol_number, protocol_date, assigned_by,
                status, score_percent, test_date, next_test_date, certificate_number)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `, [userId, course.id, protocol_number, protocol_date, req.user.id,
                h.status, h.score_percent, h.test_date, h.next_test_date, h.certificate_number]);
            historyCreated++;
          } catch (histErr) {
            errors.push(`Строка ${rowNum}: сотрудник создан, но не удалось внести обучение — ${histErr.message}`);
          }
        }
      } catch (rowErr) {
        console.error(`Error importing row ${rowNum}:`, rowErr);
        errors.push(`Строка ${rowNum}: не удалось создать сотрудника — ${rowErr.message}`);
        skipped++;
      }
    }

    res.json({ created, skipped, historyCreated, errors });
  } catch (e) {
    console.error('Error importing users:', e);
    res.status(500).json({ error: 'import_failed', message: 'Не удалось выполнить импорт: ' + e.message, details: e.message });
  }
});

// Excel-шаблон (бланк) для массовой загрузки сотрудников
// Должен быть объявлен раньше '/:id', иначе Express примет "import-template.xlsx" за id
router.get('/import-template.xlsx', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const courseRes = await query('SELECT title_ru FROM courses ORDER BY id LIMIT 1');
    const exampleCourse = courseRes.rows[0]?.title_ru || 'Точное название курса из вкладки "Курсы"';

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Сотрудники');
    ws.columns = [
      { header: 'Фамилия', key: 'last_name', width: 20 },
      { header: 'Имя', key: 'first_name', width: 20 },
      { header: 'Объект', key: 'object', width: 20 },
      { header: 'Отдел', key: 'department', width: 20 },
      { header: 'Должность', key: 'position', width: 22 },
      { header: 'Логин', key: 'login', width: 16 },
      { header: 'Пароль', key: 'password', width: 16 },
      { header: 'Курс', key: 'course', width: 32 },
      { header: '№ протокола', key: 'protocol_number', width: 16 },
      { header: 'Дата протокола', key: 'protocol_date', width: 16 },
      { header: 'Дата прохождения', key: 'test_date', width: 18 },
      { header: '№ сертификата', key: 'certificate_number', width: 18 },
      { header: 'Действителен до', key: 'next_test_date', width: 18 },
      { header: 'Результат %', key: 'score_percent', width: 14 }
    ];
    ws.getRow(1).font = { bold: true };
    ws.getColumn('protocol_date').numFmt = 'yyyy-mm-dd';
    ws.getColumn('test_date').numFmt = 'yyyy-mm-dd';
    ws.getColumn('next_test_date').numFmt = 'yyyy-mm-dd';
    ws.addRow({
      last_name: 'Иванов', first_name: 'Иван', object: 'Объект 1', department: 'Отдел ОТ',
      position: 'Инженер', login: '', password: '',
      course: '', protocol_number: '', protocol_date: '', test_date: '', certificate_number: '', next_test_date: '', score_percent: ''
    });
    ws.addRow({
      last_name: 'Петрова', first_name: 'Анна', object: 'Объект 2', department: 'Производство',
      position: 'Мастер', login: '10002', password: 'MyPass123',
      course: exampleCourse, protocol_number: '1', protocol_date: '2026-01-15', test_date: '2026-01-15',
      certificate_number: '', next_test_date: '', score_percent: '100'
    });

    const notes = wb.addWorksheet('Инструкция');
    notes.columns = [{ key: 'a', width: 100 }];
    [
      'Инструкция по заполнению файла для массовой загрузки сотрудников:',
      '1. Заполните лист "Сотрудники", по одной строке на каждого сотрудника.',
      '2. Обязательные колонки: Фамилия, Имя.',
      '3. Колонки Объект, Отдел, Должность, Логин, Пароль — необязательные.',
      '3а. Логин (или табельный номер), если указан, должен быть уникальным. Если оставить его пустым,',
      '    сотрудник будет создан только по ФИО, без доступа в систему — логин и пароль можно будет',
      '    назначить позже на вкладке "Сотрудники" кнопкой "Изменить" у нужного сотрудника.',
      '4. Если логин указан, а колонка "Пароль" оставлена пустой, система сгенерирует случайный пароль автоматически.',
      '5. Все загруженные сотрудники получают роль "Сотрудник" (employee).',
      '',
      'Колонки Курс / № протокола / Дата протокола / Дата прохождения / № сертификата / Действителен до / Результат %',
      'нужны только если у сотрудника уже ЕСТЬ пройденное ранее обучение (например, из бумажного или',
      'старого Excel-журнала), и вы хотите сразу занести его вместе с созданием сотрудника — иначе',
      'оставьте эти колонки пустыми, обучение можно будет назначить или внести позже вручную.',
      '6. Колонка "Курс" — точное название курса, как оно указано во вкладке "Курсы" (регистр не важен).',
      '7. Если заполнена колонка "Курс", обязательно заполните и № протокола, Дату протокола, Дату прохождения.',
      '8. № сертификата можно оставить пустым — он будет присвоен автоматически по текущей нумерации из',
      '   вкладки "Настройки". Действителен до — тоже необязательно, рассчитывается автоматически по сроку',
      '   действия курса и дате прохождения. Результат % по умолчанию — 100.',
      '9. Даты указывайте в формате ГГГГ-ММ-ДД (например, 2026-01-15) либо как дату в ячейке Excel.',
      '10. Такому сотруднику обучение будет сразу отмечено как пройденное — статус "СДАЛ", без прохождения теста в системе.',
      '11. Удалите строки-примеры перед загрузкой своего списка.',
      '12. Загрузите готовый файл на вкладке "Сотрудники" кнопкой "Импорт из Excel (.xlsx)".'
    ].forEach(line => notes.addRow([line]));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="users_import_template.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    res.status(500).json({ error: 'template_failed', details: e.message });
  }
});

// Meta
router.get('/meta/objects', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const objRes = await query(`SELECT DISTINCT object FROM users WHERE object != '' AND role = 'employee' ORDER BY object`);
    const depRes = await query(`SELECT DISTINCT department FROM users WHERE department != '' AND role = 'employee' ORDER BY department`);
    // pairs — реальные сочетания «объект → отдел», чтобы в фильтре список отделов
    // сужался после выбора объекта (единый фильтр по объекту/отделу на всех вкладках).
    const pairRes = await query(`SELECT DISTINCT object, department FROM users WHERE role = 'employee' AND (object != '' OR department != '')`);
    res.json({
      objects: objRes.rows.map(r => r.object),
      departments: depRes.rows.map(r => r.department),
      pairs: pairRes.rows
    });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Get single user (профиль сотрудника) — должен быть после /meta/objects, чтобы не перехватывать его
router.get('/:id', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const result = await query(
      `SELECT id, last_name, first_name, object, department, position, login, role, active,
              employment_status, status_date, created_at, permanent_certificate_number, tco_badge
       FROM users WHERE id = $1 AND role != 'superadmin'`,
      [req.params.id]
    );
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'not_found' });
    res.json(user);
  } catch (e) {
    console.error('Error fetching user:', e);
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Кадровый статус сотрудника: уволен / в декрете / вернуть в штат (п. "Архив" запроса).
// Отдельный лёгкий эндпоинт — вызывается прямо из списка сотрудников/архива одной кнопкой,
// без открытия полной формы редактирования. Доступен только для role='employee' —
// у администраторов такого статуса нет.
const EMPLOYMENT_STATUSES = ['active', 'fired', 'maternity'];
router.patch('/:id/employment-status', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  const id = Number(req.params.id);
  const { employment_status, status_date } = req.body;
  if (!EMPLOYMENT_STATUSES.includes(employment_status)) {
    return res.status(400).json({ error: 'invalid_status', message: 'Недопустимый статус' });
  }
  try {
    const targetRes = await query('SELECT * FROM users WHERE id = $1', [id]);
    const target = targetRes.rows[0];
    if (!target) return res.status(404).json({ error: 'not_found' });
    if (target.role !== 'employee') {
      return res.status(400).json({ error: 'not_employee', message: 'Статус «уволен/в декрете» применим только к сотрудникам' });
    }
    if (req.user.role === 'admin' && target.role !== 'employee') {
      return res.status(403).json({ error: 'forbidden' });
    }
    // Уволен / в декрете — сотрудник больше не может войти в систему (как обычная деактивация),
    // сразу пропадает из общего списка/статистики и появляется во вкладке «Архив».
    // Возврат в штат снова включает вход и статистику.
    const active = employment_status === 'active' ? 1 : 0;
    const dateVal = status_date ? String(status_date).trim() || null : null;
    await query(
      `UPDATE users SET employment_status = $1, status_date = $2, active = $3 WHERE id = $4`,
      [employment_status, employment_status === 'active' ? null : dateVal, active, id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('Error updating employment status:', e);
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

function validateRole(requesterRole, targetRole) {
  if (requesterRole === 'admin') return targetRole === 'employee';
  if (requesterRole === 'superadmin') return ['admin', 'employee'].includes(targetRole);
  return false;
}

// Create single user
// Логин и пароль необязательны при создании — можно добавить сотрудника
// только по ФИО и назначить ему доступ позже через редактирование карточки.
router.post('/', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  const { last_name, first_name, object, department, position, login, password, role, permanent_certificate_number, tco_badge } = req.body;
  const targetRole = role || 'employee';
  const loginVal = login && String(login).trim() ? String(login).trim() : null;

  if (!validateRole(req.user.role, targetRole)) {
    return res.status(403).json({ error: 'forbidden_role', message: 'Недостаточно прав для назначения роли' });
  }
  if (!last_name || !first_name) {
    return res.status(400).json({ error: 'missing_fields', message: 'Укажите фамилию и имя' });
  }
  if (loginVal && !password) {
    return res.status(400).json({ error: 'password_required', message: 'При указании логина укажите и пароль для него' });
  }

  try {
    if (loginVal) {
      const exists = await query('SELECT id FROM users WHERE login = $1', [loginVal]);
      if (exists.rows.length > 0) return res.status(409).json({ error: 'login_taken' });
    }

    // Защита от дублей (п.9 запроса): сотрудник должен существовать только один раз.
    // Регистр и лишние пробелы в ФИО не считаются — если такой сотрудник уже есть,
    // новая запись не создаётся, а вызывающая сторона получает данные существующего.
    if (targetRole === 'employee') {
      const dup = await findDuplicateEmployee(last_name, first_name);
      if (dup) {
        return res.status(409).json({
          error: 'duplicate_employee',
          message: 'Сотрудник с таким ФИО уже есть в системе — используйте существующую карточку',
          existing_user: dup
        });
      }
    }

    const hash = loginVal ? bcrypt.hashSync(String(password), 10) : null;
    const { normalized, translit } = computeFioFields(last_name, first_name);
    const result = await query(
      `INSERT INTO users (last_name, first_name, object, department, position, login, password_hash, role, permanent_certificate_number, tco_badge, full_name_normalized, full_name_translit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [last_name, first_name, object || '', department || '', position || '', loginVal, hash, targetRole,
       String(permanent_certificate_number || '').trim() || null,
       String(tco_badge || '').trim() || null,
       normalized, translit]
    );
    res.json({ id: result.rows[0].id });
  } catch (e) {
    console.error('Error creating user:', e);
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Update user
router.put('/:id', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  const id = Number(req.params.id);
  try {
    const targetRes = await query('SELECT * FROM users WHERE id = $1', [id]);
    const target = targetRes.rows[0];
    if (!target) return res.status(404).json({ error: 'not_found' });

    if (req.user.role === 'admin' && target.role !== 'employee') {
      return res.status(403).json({ error: 'forbidden', message: 'Администратор может редактировать только обычных сотрудников' });
    }

    const { last_name, first_name, object, department, position, login, password, active, role, permanent_certificate_number, tco_badge } = req.body;
    const fields = [];
    const params = [];

    if (role !== undefined) {
      if (req.user.role === 'admin' && role !== 'employee') {
        return res.status(403).json({ error: 'forbidden_role', message: 'Администратор не может назначать статус администратора' });
      }
      if (req.user.role === 'superadmin') {
        if (!['admin', 'employee'].includes(role)) {
          return res.status(400).json({ error: 'invalid_role' });
        }
        params.push(role);
        fields.push(`role = $${params.length}`);
      }
    }

    if (last_name !== undefined || first_name !== undefined) {
      const newLast = last_name !== undefined ? last_name : target.last_name;
      const newFirst = first_name !== undefined ? first_name : target.first_name;

      if (target.role === 'employee') {
        const dup = await findDuplicateEmployee(newLast, newFirst, id);
        if (dup) {
          return res.status(409).json({
            error: 'duplicate_employee',
            message: 'Сотрудник с таким ФИО уже есть в системе',
            existing_user: dup
          });
        }
      }

      const { normalized, translit } = computeFioFields(newLast, newFirst);
      params.push(normalized); fields.push(`full_name_normalized = $${params.length}`);
      params.push(translit); fields.push(`full_name_translit = $${params.length}`);
    }
    if (last_name !== undefined) { params.push(last_name); fields.push(`last_name = $${params.length}`); }
    if (first_name !== undefined) { params.push(first_name); fields.push(`first_name = $${params.length}`); }
    if (object !== undefined) { params.push(object); fields.push(`object = $${params.length}`); }
    if (department !== undefined) { params.push(department); fields.push(`department = $${params.length}`); }
    if (position !== undefined) { params.push(position); fields.push(`position = $${params.length}`); }

    // Уникальный номер сотрудника (№ сертификата) — редактируется вручную в карточке
    // профиля (п.2 запроса). Это отдельное поле таблицы users и никак не связано с
    // записями таблицы assignments, поэтому вся история тестирования сотрудника
    // (пройденные курсы, баллы, ответы) сохраняется без изменений при его правке.
    if (permanent_certificate_number !== undefined) {
      params.push(String(permanent_certificate_number).trim() || null);
      fields.push(`permanent_certificate_number = $${params.length}`);
    }

    // № пропуска ТШО — попадает в Word-протокол (вкладка «Протоколы»)
    if (tco_badge !== undefined) {
      params.push(String(tco_badge).trim() || null);
      fields.push(`tco_badge = $${params.length}`);
    }

    // Логин можно оставить пустым (сотрудник без доступа) или назначить/сменить в любой момент.
    // Пустая строка трактуется как "убрать логин" (сохраняется как NULL — так уникальность
    // логина не конфликтует между несколькими сотрудниками без доступа).
    let loginVal;
    if (login !== undefined) {
      loginVal = String(login).trim() ? String(login).trim() : null;
      if (loginVal) {
        const existing = await query('SELECT id FROM users WHERE login = $1 AND id != $2', [loginVal, id]);
        if (existing.rows.length > 0) return res.status(409).json({ error: 'login_taken' });
      }
      params.push(loginVal);
      fields.push(`login = $${params.length}`);
    }

    // Если в итоге у сотрудника появляется логин, у него должен быть и пароль —
    // либо он уже был задан раньше, либо его нужно указать в этом же запросе.
    const finalLogin = login !== undefined ? loginVal : target.login;
    const willHavePassword = password || target.password_hash;
    if (finalLogin && !willHavePassword) {
      return res.status(400).json({ error: 'password_required', message: 'При указании логина укажите и пароль для него' });
    }

    if (active !== undefined) { params.push(active ? 1 : 0); fields.push(`active = $${params.length}`); }
    if (password) {
      params.push(bcrypt.hashSync(String(password), 10));
      fields.push(`password_hash = $${params.length}`);
    }

    if (fields.length === 0) return res.json({ ok: true });
    params.push(id);
    await query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${params.length}`, params);
    res.json({ ok: true });
  } catch (e) {
    console.error('Error updating user:', e);
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Delete user
router.delete('/:id', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  const id = Number(req.params.id);
  try {
    const targetRes = await query('SELECT * FROM users WHERE id = $1', [id]);
    const target = targetRes.rows[0];
    if (!target) return res.status(404).json({ error: 'not_found' });
    if (req.user.role === 'admin' && target.role !== 'employee') {
      return res.status(403).json({ error: 'forbidden' });
    }
    if (target.role === 'superadmin') {
      return res.status(403).json({ error: 'cannot_delete_superadmin' });
    }
    await query('DELETE FROM users WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Error deleting user:', e);
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

module.exports = router;
