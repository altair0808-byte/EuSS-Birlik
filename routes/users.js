const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx'); // для ЧТЕНИЯ загружаемых файлов — заметно терпимее ExcelJS
                               // к файлам, созданным не Microsoft Excel (LibreOffice, Google
                               // Таблицы, openpyxl/Python-выгрузки из 1С и т.п.). Бланк для
                               // скачивания по-прежнему генерируется через ExcelJS ниже.
const { enrollNewUser } = require('../lib/positionCourses');
const { query, pool, restoreExpiredLeaves } = require('../db');
const { authRequired, requireRole } = require('./auth');
const { makeUploader } = require('../upload');
const { buildHistoricalFields } = require('./assignments');
const { computeFioFields, transliterate } = require('../lib/fio');
const { splitMulti, scopedFilter } = require('../lib/multiFilter');
const { COMMITTEE_ROLES } = require('../lib/committeeRoles');
const { logAction, fullName } = require('../lib/audit');
const driveSync = require('../driveSync');

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


// Категория сотрудника: обычный сотрудник или руководитель
const STAFF_CATEGORIES = ['employee', 'manager'];
function normalizeStaffCategory(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim().toLowerCase();
  if (!STAFF_CATEGORIES.includes(s)) throw new Error('invalid_staff_category');
  return s;
}
// Дата YYYY-MM-DD (пустое значение -> null, некорректное -> ошибка)
function normalizeDateOnly(v) {
  if (v === undefined) return undefined;
  if (v === null || String(v).trim() === '') return null;
  const s = String(v).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(new Date(s + 'T00:00:00Z').getTime())) throw new Error('invalid_date');
  return s;
}

const upload = makeUploader('imports');

// List users (суперадмин скрыт из списка)
// 'assistant' допущен — но видит только сотрудников своей зоны (assistant_objects/departments),
// см. scopedFilter() ниже; если зона не выдана — пустой список (безопасный дефолт).
router.get('/', authRequired, requireRole('admin', 'assistant', 'superadmin'), async (req, res) => {
  try {
    const { object, department, q } = req.query;
    // Администраторы не входят в список сотрудников и статистику: по умолчанию отдаём только
    // сотрудников. Список администраторов (?role=admin) — вкладка «Администраторы», только суперадмин.
    // ?role=staff — админы И ассистенты вместе (вкладка «Администраторы и ассистенты»);
    // ?role=admin / ?role=assistant — только одна из этих ролей.
    const roleParam = req.query.role;
    const roles = roleParam === 'staff' ? ['admin', 'assistant']
      : roleParam === 'admin' ? ['admin']
      : roleParam === 'assistant' ? ['assistant']
      : ['employee'];
    if (roles[0] !== 'employee' && req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'forbidden_role', message: 'Список администраторов и ассистентов доступен только суперадмину' });
    }
    // Кадровый статус: по умолчанию отдаём только действующих сотрудников (employment_status='active'),
    // как и раньше — уволенные/в декрете не должны неожиданно появляться в общем списке и статистике.
    // ?status=archive — вкладка «Архив» (уволены / в декрете). ?status=all — вообще без фильтра.
    // ?statuses=fired,maternity — точечный мульти-выбор конкретных статусов (п.2 запроса,
    // мульти-выбор фильтров) — если передан, имеет приоритет над ?status.
    const statusesParam = splitMulti(req.query.statuses);
    const statusFilter = req.query.status === 'archive' ? 'archive' : (req.query.status === 'all' ? 'all' : 'active');
    await restoreExpiredLeaves();
    let sql = `SELECT id, last_name, first_name, object, department, position, login, role, active,
                      employment_status, to_char(status_date, 'YYYY-MM-DD') AS status_date,
                      to_char(status_date_end, 'YYYY-MM-DD') AS status_date_end,
                      staff_category, to_char(hire_date, 'YYYY-MM-DD') AS hire_date,
                      created_at, permanent_certificate_number, tco_badge,
                      committee_role, iin, assistant_objects, assistant_departments
               FROM users WHERE role = ANY($1::text[])`;
    const params = [roles];
    if (statusesParam.length) {
      params.push(statusesParam);
      sql += ` AND employment_status = ANY($${params.length}::text[])`;
    } else if (statusFilter === 'active') sql += ` AND employment_status = 'active'`;
    else if (statusFilter === 'archive') sql += ` AND employment_status IN ('fired', 'maternity')`;
    // Объект / отдел / должность — теперь мульти-выбор (п.2 запроса): можно показать сразу
    // несколько объектов, отделов или должностей вместо одного за раз.
    // Для role='assistant' пересекаем выбор пользователя с его зоной (scopedFilter) —
    // если зона не выдана суперадмином, доступа нет, отдаём пустой список без запроса к БД.
    const scope = scopedFilter(req.user, splitMulti(object), splitMulti(department));
    if (scope.noAccess) return res.json([]);
    const objects = scope.objects;
    const departments = scope.departments;
    const positions = splitMulti(req.query.position);
    if (objects.length) { params.push(objects); sql += ` AND object = ANY($${params.length}::text[])`; }
    if (departments.length) { params.push(departments); sql += ` AND department = ANY($${params.length}::text[])`; }
    if (positions.length) { params.push(positions); sql += ` AND position = ANY($${params.length}::text[])`; }
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
          await enrollNewUser(userId, req.user.id);
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
            }, userId);
            const histIns = await query(`
              INSERT INTO assignments (user_id, course_id, protocol_number, protocol_date, assigned_by,
                status, score_percent, test_date, next_test_date, certificate_number)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id
            `, [userId, course.id, protocol_number, protocol_date, req.user.id,
                h.status, h.score_percent, h.test_date, h.next_test_date, h.certificate_number]);
            historyCreated++;
            // Запасное хранилище (Google Drive): удостоверение по внесённому обучению уйдёт в облако в фоне
            driveSync.enqueueIdCard(histIns.rows[0].id, req);
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

    await logAction(req, 'users_imported', {
      entityType: 'user', entityName: String(req.file.originalname || ''),
      details: { created, skipped, historyCreated, errors: errors.length }
    });
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
router.get('/meta/objects', authRequired, requireRole('admin', 'assistant', 'superadmin'), async (req, res) => {
  try {
    const objRes = await query(`SELECT DISTINCT object FROM users WHERE object != '' AND role = 'employee' ORDER BY object`);
    const depRes = await query(`SELECT DISTINCT department FROM users WHERE department != '' AND role = 'employee' ORDER BY department`);
    // pairs — реальные сочетания «объект → отдел», чтобы в фильтре список отделов
    // сужался после выбора объекта (единый фильтр по объекту/отделу на всех вкладках).
    const pairRes = await query(`SELECT DISTINCT object, department FROM users WHERE role = 'employee' AND (object != '' OR department != '')`);
    let objects = objRes.rows.map(r => r.object);
    let departments = depRes.rows.map(r => r.department);
    let pairs = pairRes.rows;
    // Ассистент видит в фильтре только объекты/отделы своей зоны.
    if (req.user.role === 'assistant') {
      const zoneObjects = Array.isArray(req.user.assistant_objects) ? req.user.assistant_objects : [];
      const zoneDepartments = Array.isArray(req.user.assistant_departments) ? req.user.assistant_departments : [];
      if (!zoneObjects.length && !zoneDepartments.length) {
        return res.json({ objects: [], departments: [], pairs: [] });
      }
      pairs = pairs.filter(p => isInAssistantScope(req.user, p));
      objects = [...new Set(pairs.map(p => p.object).filter(Boolean))].sort();
      departments = [...new Set(pairs.map(p => p.department).filter(Boolean))].sort();
    }
    res.json({ objects, departments, pairs });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Свои данные о работе в компании (для дашборда сотрудника): дата начала работы и категория.
// Должен быть раньше '/:id', иначе 'me' будет принят за id.
router.get('/me/work', authRequired, async (req, res) => {
  try {
    const r = await query(
      `SELECT to_char(hire_date, 'YYYY-MM-DD') AS hire_date, staff_category FROM users WHERE id = $1`,
      [req.user.id]
    );
    const row = r.rows[0] || {};
    res.setHeader('Cache-Control', 'no-store');
    res.json({ hire_date: row.hire_date || null, staff_category: row.staff_category || 'employee' });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Get single user (профиль сотрудника) — должен быть после /meta/objects, чтобы не перехватывать его
router.get('/:id', authRequired, requireRole('admin', 'assistant', 'superadmin'), async (req, res) => {
  try {
    const result = await query(
      `SELECT id, last_name, first_name, object, department, position, login, role, active,
              employment_status, to_char(status_date, 'YYYY-MM-DD') AS status_date,
              to_char(status_date_end, 'YYYY-MM-DD') AS status_date_end,
              staff_category, to_char(hire_date, 'YYYY-MM-DD') AS hire_date,
              created_at, permanent_certificate_number, tco_badge,
              committee_role, iin, public_uid, assistant_objects, assistant_departments
       FROM users WHERE id = $1 AND role != 'superadmin'`,
      [req.params.id]
    );
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'not_found' });
    if (!isInAssistantScope(req.user, user)) {
      return res.status(403).json({ error: 'forbidden', message: 'Сотрудник вне вашей зоны доступа' });
    }
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
  const { employment_status } = req.body;
  if (!EMPLOYMENT_STATUSES.includes(employment_status)) {
    return res.status(400).json({ error: 'invalid_status', message: 'Недопустимый статус' });
  }
  let startDate, endDate;
  try {
    startDate = normalizeDateOnly(req.body.status_date);
    endDate = normalizeDateOnly(req.body.status_date_end);
  } catch (e) {
    return res.status(400).json({ error: 'invalid_date', message: 'Некорректная дата (нужен формат ГГГГ-ММ-ДД)' });
  }
  // Отпуск: обязательно указываем период «с — по»
  if (employment_status === 'maternity') {
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'leave_dates_required', message: 'Укажите даты отпуска: с какого и по какое число' });
    }
    if (endDate < startDate) {
      return res.status(400).json({ error: 'invalid_date_range', message: 'Дата окончания отпуска раньше даты начала' });
    }
  }
  try {
    const targetRes = await query('SELECT * FROM users WHERE id = $1', [id]);
    const target = targetRes.rows[0];
    if (!target) return res.status(404).json({ error: 'not_found' });
    if (target.role !== 'employee') {
      return res.status(400).json({ error: 'not_employee', message: 'Статус «уволен / в отпуске» применим только к сотрудникам и руководителям' });
    }
    // Уволен / в отпуске — сотрудник больше не может войти в систему (как обычная деактивация),
    // сразу пропадает из общего списка/статистики и появляется во вкладке «Архив».
    // Возврат в штат снова включает вход и статистику. Из отпуска сотрудник возвращается
    // автоматически после даты окончания (см. restoreExpiredLeaves в db.js).
    const active = employment_status === 'active' ? 1 : 0;
    const dateVal = employment_status === 'active' ? null : startDate;
    const endVal = employment_status === 'maternity' ? endDate : null;
    await query(
      `UPDATE users SET employment_status = $1, status_date = $2, status_date_end = $3, active = $4 WHERE id = $5`,
      [employment_status, dateVal, endVal, active, id]
    );
    await logAction(req, 'employment_status_changed', {
      entityType: 'user', entityId: id, entityName: fullName(target),
      details: { status: employment_status, date: dateVal, date_end: endVal }
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('Error updating employment status:', e);
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// ТЗ: роли/ИИН/PDF=копия Word §2, §9 — admin и assistant не могут назначать роли вообще
// (поле «Роль» видит только суперадмин, как и раньше); ассистент может создавать только
// обычных сотрудников (employee) в своей зоне; суперадмин может назначить
// admin/assistant/employee (роль superadmin через этот эндпоинт не выдаётся никому).
function validateRole(requesterRole, targetRole) {
  if (requesterRole === 'admin' || requesterRole === 'assistant') return targetRole === 'employee';
  if (requesterRole === 'superadmin') return ['admin', 'assistant', 'employee'].includes(targetRole);
  return false;
}

// Поля карточки сотрудника, которые роль 'assistant' вправе редактировать:
// ФИО / Объект / Отдел / Должность / № пропуска ТШО / ИИН. Объект и отдел — только внутри
// своей зоны (см. valueInAssistantZone). Логин/пароль, № сертификата, роль, комиссия,
// кадровый статус — по-прежнему только admin/superadmin.
const ASSISTANT_EDITABLE_FIELDS = ['last_name', 'first_name', 'object', 'department', 'position', 'tco_badge', 'iin'];

// Проверка, что значение объекта/отдела лежит в зоне ассистента (зона по этому измерению не
// ограничена — значит любое значение допустимо).
function valueInAssistantZone(reqUser, object, department) {
  const zoneObjects = Array.isArray(reqUser.assistant_objects) ? reqUser.assistant_objects : [];
  const zoneDepartments = Array.isArray(reqUser.assistant_departments) ? reqUser.assistant_departments : [];
  if (!zoneObjects.length && !zoneDepartments.length) return false;
  if (object !== undefined && zoneObjects.length && !zoneObjects.includes(object)) return false;
  if (department !== undefined && zoneDepartments.length && !zoneDepartments.includes(department)) return false;
  return true;
}

// ИИН (Казахстан) — ровно 12 цифр, без пробелов/дефисов. Пустое значение снимает поле.
// Контрольную сумму по алгоритму РК на первом этапе не проверяем (ТЗ §6, №6 открытых вопросов).
function normalizeIin(value) {
  if (value === undefined) return undefined;
  const v = String(value || '').trim();
  if (!v) return null;
  if (!/^\d{12}$/.test(v)) {
    throw new Error('invalid_iin');
  }
  return v;
}

// Зона видимости ассистента (ТЗ §4): суперадмин выбирает assistant_objects/assistant_departments
// в userModal; пустые массивы обоих полей — "доступа нет" (безопасный дефолт).
function normalizeZoneArray(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  return value.map(v => String(v || '').trim()).filter(Boolean);
}

// Виден ли targetUser текущему пользователю с учётом его зоны (assistant) — для
// admin/superadmin всегда true. Сам сотрудник (employee) сверяется по object/department.
function isInAssistantScope(reqUser, targetUser) {
  if (!reqUser || reqUser.role !== 'assistant') return true;
  const zoneObjects = Array.isArray(reqUser.assistant_objects) ? reqUser.assistant_objects : [];
  const zoneDepartments = Array.isArray(reqUser.assistant_departments) ? reqUser.assistant_departments : [];
  if (!zoneObjects.length && !zoneDepartments.length) return false;
  const objOk = zoneObjects.length ? zoneObjects.includes(targetUser.object) : true;
  const depOk = zoneDepartments.length ? zoneDepartments.includes(targetUser.department) : true;
  return objOk && depOk;
}

// Роль в комиссии по проверке знаний (модуль электронного подписания протоколов,
// п.1 запроса) — пустая строка/undefined снимают роль, иначе значение должно быть
// одним из COMMITTEE_ROLES.
function normalizeCommitteeRole(value) {
  const v = value === undefined ? undefined : (String(value || '').trim() || null);
  if (v !== undefined && v !== null && !COMMITTEE_ROLES.includes(v)) {
    throw new Error('invalid_committee_role');
  }
  return v;
}

// Create single user
// Логин и пароль необязательны при создании — можно добавить сотрудника
// только по ФИО и назначить ему доступ позже через редактирование карточки.
router.post('/', authRequired, requireRole('admin', 'assistant', 'superadmin'), async (req, res) => {
  // Ассистент создаёт только сотрудников своей зоны: без логина/пароля, роли, № сертификата и
  // комиссии — эти поля игнорируем, даже если их прислал фронтенд.
  if (req.user.role === 'assistant') {
    for (const f of ['login', 'password', 'role', 'permanent_certificate_number', 'committee_role', 'assistant_objects', 'assistant_departments']) {
      delete req.body[f];
    }
    let o = String(req.body.object || '').trim();
    let d = String(req.body.department || '').trim();
    const zObjs = Array.isArray(req.user.assistant_objects) ? req.user.assistant_objects : [];
    const zDeps = Array.isArray(req.user.assistant_departments) ? req.user.assistant_departments : [];
    // Если зона однозначна (один объект / один отдел) — подставляем сами; если зона ограничивает поле, а оно
    // пустое, говорим об этом прямо, а не «вне зоны» (пустое значение в зону не входит).
    if (!o && zObjs.length === 1) o = zObjs[0];
    if (!d && zDeps.length === 1) d = zDeps[0];
    if (zObjs.length && !o) return res.status(400).json({ error: 'zone_required', message: 'Выберите объект из вашей зоны доступа' });
    if (zDeps.length && !d) return res.status(400).json({ error: 'zone_required', message: 'Выберите отдел из вашей зоны доступа' });
    req.body.object = o;
    req.body.department = d;
    if (!valueInAssistantZone(req.user, o, d)) {
      return res.status(403).json({ error: 'out_of_zone', message: 'Объект/отдел вне вашей зоны доступа' });
    }
  }
  const { last_name, first_name, object, department, position, login, password, role, permanent_certificate_number, tco_badge, committee_role, iin, assistant_objects, assistant_departments } = req.body;
  let staffCategoryVal, hireDateVal;
  try {
    staffCategoryVal = normalizeStaffCategory(req.body.staff_category) || 'employee';
    hireDateVal = normalizeDateOnly(req.body.hire_date) ?? null;
  } catch (e) {
    return res.status(400).json({ error: e.message === 'invalid_date' ? 'invalid_date' : 'invalid_staff_category', message: e.message === 'invalid_date' ? 'Некорректная дата начала работы' : 'Недопустимая категория сотрудника' });
  }
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
  let committeeRoleVal;
  try {
    committeeRoleVal = normalizeCommitteeRole(committee_role) || null;
  } catch (e) {
    return res.status(400).json({ error: 'invalid_committee_role', message: 'Недопустимая роль в комиссии' });
  }
  let iinVal;
  try {
    iinVal = normalizeIin(iin) ?? null;
  } catch (e) {
    return res.status(400).json({ error: 'invalid_iin', message: 'ИИН должен состоять ровно из 12 цифр' });
  }
  // Зона видимости — только суперадмин может её выдавать, и только для роли assistant
  const zoneObjects = targetRole === 'assistant' ? (normalizeZoneArray(assistant_objects) || []) : [];
  const zoneDepartments = targetRole === 'assistant' ? (normalizeZoneArray(assistant_departments) || []) : [];

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
      `INSERT INTO users (last_name, first_name, object, department, position, login, password_hash, role, permanent_certificate_number, tco_badge, full_name_normalized, full_name_translit, committee_role, iin, assistant_objects, assistant_departments, staff_category, hire_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id`,
      [last_name, first_name, object || '', department || '', position || '', loginVal, hash, targetRole,
       String(permanent_certificate_number || '').trim() || null,
       String(tco_badge || '').trim() || null,
       normalized, translit, committeeRoleVal, iinVal, zoneObjects, zoneDepartments,
       targetRole === 'employee' ? staffCategoryVal : 'employee', hireDateVal]
    );
    await logAction(req, 'user_created', {
      entityType: 'user', entityId: result.rows[0].id, entityName: `${last_name} ${first_name}`.trim(),
      details: { role: targetRole, object: object || '', department: department || '', position: position || '' }
    });
    if (targetRole === 'employee') await enrollNewUser(result.rows[0].id, req.user.id);
    res.json({ id: result.rows[0].id });
  } catch (e) {
    console.error('Error creating user:', e);
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Update user
router.put('/:id', authRequired, requireRole('admin', 'assistant', 'superadmin'), async (req, res) => {
  const id = Number(req.params.id);
  try {
    const targetRes = await query('SELECT * FROM users WHERE id = $1', [id]);
    const target = targetRes.rows[0];
    if (!target) return res.status(404).json({ error: 'not_found' });

    if (req.user.role === 'admin' && target.role !== 'employee') {
      return res.status(403).json({ error: 'forbidden', message: 'Администратор может редактировать только обычных сотрудников' });
    }
    if (req.user.role === 'assistant') {
      if (target.role !== 'employee') {
        return res.status(403).json({ error: 'forbidden', message: 'Ассистент может редактировать только карточки сотрудников' });
      }
      if (!isInAssistantScope(req.user, target)) {
        return res.status(403).json({ error: 'forbidden', message: 'Сотрудник вне вашей зоны доступа' });
      }
      // ТЗ §3, §9: ассистент может менять только ФИО/Должность/№ пропуска ТШО/ИИН —
      // игнорируем остальные поля тела запроса, даже если фронтенд их случайно пришлёт.
      const filtered = {};
      for (const f of ASSISTANT_EDITABLE_FIELDS) {
        if (req.body[f] !== undefined) filtered[f] = req.body[f];
      }
      req.body = filtered;
      if (!valueInAssistantZone(req.user, filtered.object, filtered.department)) {
        return res.status(403).json({ error: 'out_of_zone', message: 'Объект/отдел вне вашей зоны доступа' });
      }
    }

    const { last_name, first_name, object, department, position, login, password, active, role, permanent_certificate_number, tco_badge, committee_role, iin, assistant_objects, assistant_departments } = req.body;
    const fields = [];
    const params = [];

    // Категория (сотрудник / руководитель) и дата начала работы — только админ/суперадмин
    // (в ASSISTANT_EDITABLE_FIELDS этих полей нет, так что у ассистента они сюда не попадут).
    if (req.body.staff_category !== undefined || req.body.hire_date !== undefined) {
      try {
        const cat = normalizeStaffCategory(req.body.staff_category);
        if (cat !== undefined) { params.push(cat); fields.push(`staff_category = $${params.length}`); }
        const hd = normalizeDateOnly(req.body.hire_date);
        if (hd !== undefined) { params.push(hd); fields.push(`hire_date = $${params.length}`); }
      } catch (e) {
        return res.status(400).json({ error: e.message === 'invalid_date' ? 'invalid_date' : 'invalid_staff_category', message: e.message === 'invalid_date' ? 'Некорректная дата начала работы' : 'Недопустимая категория сотрудника' });
      }
    }

    // Роль в комиссии по проверке знаний (модуль электронного подписания протоколов).
    // Пустая строка/null снимает роль — при этом сохранённая подпись сотрудника
    // не удаляется автоматически (администратор может назначить роль обратно позже).
    if (committee_role !== undefined) {
      let committeeRoleVal;
      try {
        committeeRoleVal = normalizeCommitteeRole(committee_role) || null;
      } catch (e) {
        return res.status(400).json({ error: 'invalid_committee_role', message: 'Недопустимая роль в комиссии' });
      }
      params.push(committeeRoleVal);
      fields.push(`committee_role = $${params.length}`);
    }

    if (role !== undefined) {
      if (req.user.role === 'admin' && role !== 'employee') {
        return res.status(403).json({ error: 'forbidden_role', message: 'Администратор не может назначать статус администратора' });
      }
      if (req.user.role === 'superadmin') {
        if (!['admin', 'assistant', 'employee'].includes(role)) {
          return res.status(400).json({ error: 'invalid_role' });
        }
        params.push(role);
        fields.push(`role = $${params.length}`);
      }
    }

    // ИИН — доступно и ассистенту (входит в его 4 редактируемых поля), формат 12 цифр
    if (iin !== undefined) {
      let iinVal;
      try {
        iinVal = normalizeIin(iin) ?? null;
      } catch (e) {
        return res.status(400).json({ error: 'invalid_iin', message: 'ИИН должен состоять ровно из 12 цифр' });
      }
      params.push(iinVal);
      fields.push(`iin = $${params.length}`);
    }

    // Зона видимости ассистента (ТЗ §4) — только суперадмин может её менять, и видна
    // только когда у пользователя (текущего или уже назначенного) роль 'assistant'.
    if (req.user.role === 'superadmin') {
      if (assistant_objects !== undefined) {
        params.push(normalizeZoneArray(assistant_objects) || []);
        fields.push(`assistant_objects = $${params.length}`);
      }
      if (assistant_departments !== undefined) {
        params.push(normalizeZoneArray(assistant_departments) || []);
        fields.push(`assistant_departments = $${params.length}`);
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

    // Сменили объект/отдел/должность — записываем сотрудника на курсы новой должности
    // (то, что у него уже назначено или ещё действует, повторно не назначается).
    const b0 = req.body;
    const posChanged = (b0.object !== undefined && String(b0.object || '') !== String(target.object || ''))
      || (b0.department !== undefined && String(b0.department || '') !== String(target.department || ''))
      || (b0.position !== undefined && String(b0.position || '') !== String(target.position || ''));
    if (posChanged && target.role === 'employee') await enrollNewUser(id, req.user.id);

    // Журнал: только те поля, что реально изменились. Пароль и ИИН значениями не пишем.
    try {
      const b = req.body;
      const changed = {};
      const track = (key, oldV, newV) => {
        if (newV === undefined) return;
        if (String(oldV || '') !== String(newV || '')) changed[key] = { from: oldV || '', to: newV || '' };
      };
      track('last_name', target.last_name, b.last_name);
      track('first_name', target.first_name, b.first_name);
      track('object', target.object, b.object);
      track('department', target.department, b.department);
      track('position', target.position, b.position);
      track('tco_badge', target.tco_badge, b.tco_badge);
      track('permanent_certificate_number', target.permanent_certificate_number, b.permanent_certificate_number);
      track('login', target.login, b.login);
      track('committee_role', target.committee_role, b.committee_role);
      track('staff_category', target.staff_category, b.staff_category);
      if (b.hire_date !== undefined) track('hire_date', target.hire_date ? new Date(target.hire_date).toISOString().slice(0, 10) : '', String(b.hire_date || '').slice(0, 10));
      if (req.user.role === 'superadmin') track('role', target.role, b.role);
      if (b.iin !== undefined && String(target.iin || '') !== String(b.iin || '')) changed.iin = { changed: true };
      if (b.password) changed.password = { changed: true };
      if (b.active !== undefined && Number(target.active) !== (b.active ? 1 : 0)) changed.active = { from: Number(target.active), to: b.active ? 1 : 0 };
      if (req.user.role === 'superadmin' && (b.assistant_objects !== undefined || b.assistant_departments !== undefined)) {
        const oldZ = JSON.stringify([target.assistant_objects || [], target.assistant_departments || []]);
        const newZ = JSON.stringify([
          b.assistant_objects !== undefined ? (normalizeZoneArray(b.assistant_objects) || []) : (target.assistant_objects || []),
          b.assistant_departments !== undefined ? (normalizeZoneArray(b.assistant_departments) || []) : (target.assistant_departments || [])
        ]);
        if (oldZ !== newZ) changed.zone = { changed: true };
      }
      if (Object.keys(changed).length) {
        await logAction(req, 'user_updated', {
          entityType: 'user', entityId: id,
          entityName: fullName({ last_name: b.last_name !== undefined ? b.last_name : target.last_name, first_name: b.first_name !== undefined ? b.first_name : target.first_name }),
          details: { role: target.role, changed }
        });
      }
    } catch (logErr) { console.error('audit (user_updated):', logErr.message); }

    // Синхронизация номера сертификата с логином: если в этом запросе поменяли логин
    // и/или ручной «№ сертификата» — пересчитываем номер сертификата на всех уже
    // выданных сертификатах сотрудника (assignments.certificate_number), а не только
    // на новых. Приоритет: логин, если он задан, — на сертификате всегда должен быть
    // виден именно он и никакой другой номер. Ручной permanent_certificate_number
    // используется только когда логина нет. Если оба пусты — старые номера не трогаем
    // (не обнуляем уже распечатанные сертификаты).
    if (login !== undefined || permanent_certificate_number !== undefined) {
      const finalPermanent = permanent_certificate_number !== undefined
        ? (String(permanent_certificate_number).trim() || null)
        : target.permanent_certificate_number;
      const effectiveCertNumber = finalLogin || finalPermanent || null;
      if (effectiveCertNumber) {
        await query(
          `UPDATE assignments SET certificate_number = $1
           WHERE user_id = $2 AND certificate_number IS NOT NULL AND certificate_number IS DISTINCT FROM $1`,
          [effectiveCertNumber, id]
        );
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('Error updating user:', e);
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Delete user
// ТЗ §3, §9: удаление сотрудников из базы — только суперадмин (admin эту "опасную"
// операцию больше не может выполнять).
router.delete('/:id', authRequired, requireRole('superadmin'), async (req, res) => {
  const id = Number(req.params.id);
  try {
    const targetRes = await query('SELECT * FROM users WHERE id = $1', [id]);
    const target = targetRes.rows[0];
    if (!target) return res.status(404).json({ error: 'not_found' });
    if (target.role === 'superadmin') {
      return res.status(403).json({ error: 'cannot_delete_superadmin' });
    }
    await query('DELETE FROM users WHERE id = $1', [id]);
    await logAction(req, 'user_deleted', {
      entityType: 'user', entityId: id, entityName: fullName(target), details: { role: target.role }
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('Error deleting user:', e);
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

module.exports = router;
