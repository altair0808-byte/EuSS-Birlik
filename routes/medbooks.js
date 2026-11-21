// ЛИЧНЫЕ МЕДИЦИНСКИЕ КНИЖКИ (санкнижки).
//
//   GET    /api/medbooks/positions        — все должности из структуры + период (6/12 мес.) или «не нужна»
//   PUT    /api/medbooks/positions        — сохранить набор должностей, которым нужна книжка (admin/superadmin)
//   GET    /api/medbooks/overview         — сотрудники, которым нужна книжка (по должности или вручную) + статистика
//   GET    /api/medbooks/user/:id         — книжка одного сотрудника (applicable=false — не нужна, в карточке не показываем)
//   GET    /api/medbooks/me               — то же для вошедшего сотрудника
//   PUT    /api/medbooks/user/:id         — внести/обновить дату начала книжки (+ период для «вне должности»)
//   DELETE /api/medbooks/user/:id         — убрать книжку (сбросить дату / убрать ручное добавление)
//   GET    /api/medbooks/import-template.xlsx — бланк для массовой загрузки
//   POST   /api/medbooks/import           — массовая загрузка санкнижек из Excel (+ отметка должностей)
const express = require('express');
const router = express.Router();
const { query, pool } = require('../db');
const { authRequired, requireRole } = require('./auth');
const { requireAdminFunction } = require('../lib/adminFunctions');
const { logAction } = require('../lib/audit');
const { splitMulti, scopedFilter } = require('../lib/multiFilter');
const { keyOf } = require('../lib/positionCourses');
const mb = require('../lib/medbook');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const { makeUploader } = require('../upload');
const { normalizeFio } = require('../lib/fio');

const upload = makeUploader('imports');

// Админ работает с мед. книжками только при выданной функции «Мед. книжки»; ассистент и суперадмин — как раньше
const STAFF = [requireRole('admin', 'assistant', 'superadmin'), requireAdminFunction('medbook')];
const ADMIN = [requireRole('admin', 'superadmin'), requireAdminFunction('medbook')];

async function structureRows() {
  const r = await query('SELECT org_structure FROM settings WHERE id = 1');
  const structure = (r.rows[0] && Array.isArray(r.rows[0].org_structure)) ? r.rows[0].org_structure : [];
  const rows = [];
  structure.forEach((o) => (o.departments || []).forEach((d) => (d.positions || []).forEach((p) => {
    const position = typeof p === 'string' ? p : (p && p.ru) || '';
    if (position) rows.push({ object: o.object, department: d.name, position });
  })));
  return rows;
}

function cleanNote(v) { const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 500); return t || null; }

function validPeriod(v) { const n = Number(v); return n === 6 || n === 12 ? n : null; }

// Ассистент работает только в своей зоне (объекты / отделы)
function inScope(user, target) {
  if (!user || user.role !== 'assistant') return true;
  const sc = scopedFilter(user, [], []);
  if (sc.noAccess) return false;
  if (sc.objects.length && !sc.objects.includes(target.object)) return false;
  if (sc.departments.length && !sc.departments.includes(target.department)) return false;
  return true;
}

// ---------- должности ----------
router.get('/positions', authRequired, STAFF, async (req, res) => {
  try {
    const [rows, saved] = await Promise.all([structureRows(), query('SELECT key, period_months FROM medbook_positions')]);
    const map = new Map(saved.rows.map((x) => [x.key, Number(x.period_months)]));
    res.json({ items: rows.map((r) => ({ ...r, period_months: map.get(keyOf(r.object, r.department, r.position)) || null })) });
  } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

router.put('/positions', authRequired, ADMIN, async (req, res) => {
  const client = await pool.connect();
  try {
    const rows = await structureRows();
    const index = new Map(rows.map((r) => [keyOf(r.object, r.department, r.position), r]));
    const out = new Map();
    (Array.isArray(req.body && req.body.items) ? req.body.items : []).forEach((it) => {
      const k = keyOf(it && it.object, it && it.department, it && it.position);
      const canon = index.get(k);
      const period = validPeriod(it && it.period_months);
      if (canon && period) out.set(k, { ...canon, period });
    });
    await client.query('BEGIN');
    await client.query('DELETE FROM medbook_positions');
    for (const [k, v] of out) {
      await client.query(
        'INSERT INTO medbook_positions (object, department, position, key, period_months) VALUES ($1,$2,$3,$4,$5)',
        [v.object, v.department, v.position, k, v.period]
      );
    }
    await client.query('COMMIT');
    await logAction(req, 'medbook_positions_saved', { entityType: 'medbook', entityName: 'Должности с мед. книжкой', details: { count: out.size } });
    res.json({ ok: true, count: out.size });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    res.status(500).json({ error: 'db_error', details: e.message });
  } finally { client.release(); }
});

// ---------- обзор ----------
router.get('/overview', authRequired, STAFF, async (req, res) => {
  try {
    const reqObjs = splitMulti(req.query.object), reqDeps = splitMulti(req.query.department);
    const scope = scopedFilter(req.user, reqObjs, reqDeps);
    if (scope.noAccess) return res.json({ rows: [], stats: mb.summarize([]) });
    // Ассистент выбрал объект/отдел вне своей зоны — показываем пусто, а не всех
    if (req.user.role === 'assistant' && ((reqObjs.length && !scope.objects.length) || (reqDeps.length && !scope.departments.length))) {
      return res.json({ rows: [], stats: mb.summarize([]) });
    }
    const cat = ['manager', 'specialist', 'employee'].includes(req.query.category) ? req.query.category : '';
    const rows = await mb.loadEntries({ objects: scope.objects, departments: scope.departments, category: cat, q: String(req.query.q || '').trim() });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ rows, stats: mb.summarize(rows) });
  } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

// ---------- один сотрудник ----------
async function sendUser(res, userId) {
  const e = await mb.loadEntryForUser(userId);
  res.setHeader('Cache-Control', 'no-store');
  res.json(e ? { applicable: true, ...e } : { applicable: false });
}

router.get('/me', authRequired, async (req, res) => {
  try { await sendUser(res, req.user.id); } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

router.get('/user/:id', authRequired, STAFF, async (req, res) => {
  try {
    const u = (await query('SELECT id, object, department FROM users WHERE id = $1', [req.params.id])).rows[0];
    if (!u) return res.status(404).json({ error: 'not_found' });
    if (!inScope(req.user, u)) return res.status(403).json({ error: 'forbidden_scope' });
    await sendUser(res, u.id);
  } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

router.put('/user/:id', authRequired, STAFF, async (req, res) => {
  try {
    const u = (await query(
      `SELECT id, last_name, first_name, object, department, position, role FROM users WHERE id = $1`, [req.params.id]
    )).rows[0];
    if (!u || u.role !== 'employee') return res.status(404).json({ error: 'not_found', message: 'Сотрудник не найден' });
    if (!inScope(req.user, u)) return res.status(403).json({ error: 'forbidden_scope', message: 'Сотрудник вне вашей зоны' });
    const posPeriod = (await query('SELECT period_months FROM medbook_positions WHERE key = $1', [keyOf(u.object, u.department, u.position)])).rows[0];
    const required = !!posPeriod;
    const period = required ? Number(posPeriod.period_months) : validPeriod(req.body && req.body.period_months);
    if (!period) return res.status(400).json({ error: 'bad_period', message: 'Выберите период: 6 или 12 месяцев' });
    // Можно внести либо дату медосмотра (start_date), либо срок «допуск до» (expires_date) — как в журнале
    const today = mb.todayYmd();
    const expiresIn = String((req.body && req.body.expires_date) || '');
    let start = String((req.body && req.body.start_date) || '');
    let fixedExpiry = null;
    if (mb.isYmd(expiresIn)) { fixedExpiry = expiresIn; start = mb.addMonths(expiresIn, -period); }
    if (!mb.isYmd(start)) return res.status(400).json({ error: 'bad_date', message: 'Укажите дату медосмотра или срок «допуск до»' });
    if (start > today) {
      return res.status(400).json({ error: 'future_date', message: fixedExpiry
        ? `Допуск до ${fixedExpiry} при периоде ${period} мес. значит, что медосмотр ещё не пройден — проверьте дату`
        : 'Дата медосмотра не может быть в будущем' });
    }
    // Примечание: если поле не передано — оставляем то, что уже сохранено
    const noteGiven = Object.prototype.hasOwnProperty.call(req.body || {}, 'note');
    const note = noteGiven ? cleanNote(req.body.note) : null;
    await query(
      `INSERT INTO medbook_records (user_id, start_date, period_months, manual, updated_by, updated_at, note, expires_date)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6, $8)
       ON CONFLICT (user_id) DO UPDATE SET start_date = EXCLUDED.start_date, period_months = EXCLUDED.period_months,
         manual = EXCLUDED.manual, updated_by = EXCLUDED.updated_by, updated_at = NOW(), expires_date = EXCLUDED.expires_date,
         note = CASE WHEN $7 THEN EXCLUDED.note ELSE medbook_records.note END`,
      [u.id, start, period, !required, req.user.id, note, noteGiven, fixedExpiry]
    );
    await logAction(req, 'medbook_saved', {
      entityType: 'user', entityId: u.id, entityName: `${u.last_name} ${u.first_name}`.trim(),
      details: { start_date: start, period_months: period, outside_position: !required }
    });
    await sendUser(res, u.id);
  } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

router.delete('/user/:id', authRequired, STAFF, async (req, res) => {
  try {
    const u = (await query('SELECT id, last_name, first_name, object, department, role FROM users WHERE id = $1', [req.params.id])).rows[0];
    if (!u || u.role !== 'employee') return res.status(404).json({ error: 'not_found' });
    if (!inScope(req.user, u)) return res.status(403).json({ error: 'forbidden_scope' });
    await query('DELETE FROM medbook_records WHERE user_id = $1', [u.id]);
    await logAction(req, 'medbook_removed', { entityType: 'user', entityId: u.id, entityName: `${u.last_name} ${u.first_name}`.trim() });
    await sendUser(res, u.id);
  } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

// =====================================================================================
// МАССОВАЯ ЗАГРУЗКА САНКНИЖЕК ИЗ EXCEL
//  • Одна строка — один сотрудник. Ищем по ИИН, затем по «Фамилия Имя» (без учёта регистра,
//    ё/е и казахских букв: Қалжанов = Калжанов). Сотрудник должен уже быть на сайте.
//  • «Допуск до» — дата, до которой действует книжка (как в журналах). Дата начала считается
//    сама: «Допуск до» минус период. Можно вместо этого дать колонку «Дата начала».
//  • Галочка «Отметить должности»: должность найденного сотрудника (как она записана на сайте)
//    добавляется в «Должности и периодичность» — книжка становится обязательной для всей
//    должности, и новые сотрудники этой должности сразу попадают в список «Дата не внесена».
// =====================================================================================
const KZ_FOLD = { 'ә': 'а', 'ғ': 'г', 'қ': 'к', 'ң': 'н', 'ө': 'о', 'ұ': 'у', 'ү': 'у', 'һ': 'х', 'і': 'и', 'й': 'и', 'ъ': '', 'ь': '' };
function looseFio(s) {
  return normalizeFio(s).replace(/[әғқңөұүһійъь]/g, (c) => KZ_FOLD[c]).replace(/[^a-zа-я ]/g, '').replace(/\s+/g, ' ').trim();
}

// «Скелет» ФИО для сравнения кириллицы с латиницей: на сайте часть сотрудников записана латиницей
// (Daniyal Namazaliyev), часть — с казахскими буквами или без мягкого знака. Всё переводим в латиницу,
// упрощаем близкие звуки и убираем удвоения: «Садуакассова Гулнара» = «Садуакасова Гульнара» = «Saduakassova Gulnara».
const SK_MAP = { 'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e', 'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'i', 'к': 'k', 'л': 'l',
  'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'h', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'sh',
  'ъ': '', 'ы': 'i', 'ь': '', 'э': 'e', 'ю': 'iu', 'я': 'ia', 'ә': 'a', 'ғ': 'g', 'қ': 'k', 'ң': 'n', 'ө': 'o', 'ұ': 'u', 'ү': 'u', 'һ': 'h', 'і': 'i' };
function skeletonFio(s) {
  let out = '';
  for (const ch of String(s || '').toLowerCase()) out += Object.prototype.hasOwnProperty.call(SK_MAP, ch) ? SK_MAP[ch] : ch;
  return out.replace(/kh/g, 'h').replace(/y/g, 'i').replace(/j/g, 'zh').replace(/q/g, 'k').replace(/w/g, 'u').replace(/x/g, 'ks')
    .replace(/[^a-z ]/g, '').replace(/(.)\1+/g, '$1').replace(/\s+/g, ' ').trim();
}

function parseImportDate(v) {
  if (v === undefined || v === null || v === '') return null;
  let d = null;
  if (v instanceof Date) d = new Date(v.getTime() + 12 * 3600 * 1000);
  else if (typeof v === 'number') d = new Date(Math.round((v - 25569) * 86400 * 1000));
  else {
    const s = String(v).trim();
    if (!s) return null;
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    else if ((m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-]{1,2}(\d{2}|\d{4})\b/))) {
      const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      d = new Date(Date.UTC(y, +m[2] - 1, +m[1]));
    } else if (/^\d+(\.\d+)?$/.test(s)) d = new Date(Math.round((Number(s) - 25569) * 86400 * 1000));
  }
  if (!d || isNaN(d.getTime())) throw new Error('bad_date');
  const iso = d.toISOString().slice(0, 10);
  if (iso < '2000-01-01' || iso > '2100-01-01') throw new Error('bad_date');
  return iso;
}

const { narrowNamesakes, namesakesHint, NAMESAKE_ERROR } = require('../lib/namesakes');
const IMPORT_HEADERS = {
  'фамилия': 'last_name', 'имя': 'first_name', 'фио': 'fio', 'ф.и.о.': 'fio', 'ф.и.о': 'fio', 'иин': 'iin',
  'допуск до': 'expires', 'действует до': 'expires', 'срок допуска': 'expires', 'сроки допуска': 'expires', 'срок действия': 'expires', 'годна до': 'expires',
  'дата начала': 'start', 'начало': 'start', 'дата медосмотра': 'start',
  'период': 'period', 'период (мес.)': 'period', 'период (мес)': 'period', 'периодичность': 'period', 'периодичность (мес.)': 'period',
  'примечание': 'note', 'примечания': 'note',
  ...require('../lib/namesakes').NAMESAKE_HEADERS
};

router.get('/import-template.xlsx', authRequired, STAFF, async (req, res) => {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Санкнижки');
    ws.columns = [
      { header: 'Фамилия', key: 'last_name', width: 20 },
      { header: 'Имя', key: 'first_name', width: 18 },
      { header: 'ИИН', key: 'iin', width: 15 },
      { header: 'Должность (в журнале)', key: 'pos', width: 24 },
      { header: 'Допуск до', key: 'expires', width: 13 },
      { header: 'Период (мес.)', key: 'period', width: 13 },
      { header: 'Примечание', key: 'note', width: 40 }
    ];
    ws.getRow(1).font = { bold: true };
    ws.getColumn('iin').numFmt = '@';
    ws.getColumn('expires').numFmt = 'dd.mm.yyyy';
    ws.addRow({ last_name: 'Иванова', first_name: 'Мария', iin: '', pos: 'повар', expires: new Date(Date.UTC(2027, 2, 15)), period: 12, note: 'ФГ до 15.09.2027' });
    ws.dataValidations.add('F2:F3000', { type: 'list', allowBlank: true, formulae: ['"6,12"'], showErrorMessage: false });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    const notes = wb.addWorksheet('Инструкция');
    notes.columns = [{ key: 'a', width: 110 }];
    [
      'Как заполнить бланк «Санкнижки»:',
      '1. Одна строка — один сотрудник. Сотрудник должен уже быть на сайте (вкладка «Сотрудники»).',
      '2. Сотрудник ищется по ИИН, а если ИИН пустой — по Фамилии и Имени (можно одной колонкой «ФИО»).',
      '3. «Допуск до» — дата из журнала, до которой действует санкнижка (например 15.03.2027 или 15.03.27).',
      '   Дата начала посчитается сама: «Допуск до» минус период. Вместо «Допуск до» можно дать колонку «Дата начала».',
      '4. «Период (мес.)» — 12 (раз в год) или 6 (два раза в год, например бармены). Пусто — 12.',
      '   Если должность сотрудника уже отмечена в «Должности и периодичность», берётся период должности.',
      '5. «Должность (в журнале)» — только для справки: на сайте используется должность из карточки сотрудника.',
      '6. «Примечание» — ФГ, СМ, где проходил и т.п. Показывается в списке санкнижек.',
      '7. Удалите строку-пример (Иванова) перед загрузкой.'
    ].forEach((l) => notes.addRow([l]));
    notes.getRow(1).font = { bold: true };
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="medbooks_template.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { res.status(500).json({ error: 'template_failed', details: e.message }); }
});

router.post('/import', authRequired, STAFF, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file', message: 'Файл не выбран' });
  const fs = require('fs');
  const cleanup = () => { try { fs.unlinkSync(req.file.path); } catch (_) { /* ignore */ } };
  if (!String(req.file.originalname || '').toLowerCase().endsWith('.xlsx')) {
    cleanup();
    return res.status(400).json({ error: 'invalid_format', message: 'Поддерживается только .xlsx. Сохраните файл как «Книга Excel (.xlsx)».' });
  }
  // Отмечать должности может только админ/суперадмин (ассистенту настройка должностей недоступна)
  const canMark = ['admin', 'superadmin'].includes(req.user.role);
  const markPositions = canMark && ['1', 'true', 'on', 'yes'].includes(String((req.body && req.body.mark_positions) || '').toLowerCase());
  let sheetRows;
  try {
    const wb = XLSX.readFile(req.file.path, { cellDates: true, raw: true });
    const name = wb.SheetNames[0];
    sheetRows = name ? XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: true }) : [];
  } catch (e) {
    cleanup();
    return res.status(400).json({ error: 'invalid_file', message: 'Не удалось прочитать файл. Убедитесь, что это корректный .xlsx без пароля.' });
  }
  cleanup();
  try {
    // Строка заголовков — первая, где есть «ФИО» или «Фамилия»
    let h = sheetRows.findIndex((r) => (r || []).some((v) => ['фио', 'фамилия', 'ф.и.о.', 'ф.и.о'].includes(String(v || '').trim().toLowerCase())));
    if (h < 0) return res.status(400).json({ error: 'missing_columns', message: 'Не найдена строка заголовков: нужны колонки «Фамилия» и «Имя» (или «ФИО») и «Допуск до». Скачайте бланк.' });
    const col = {};
    sheetRows[h].forEach((v, i) => {
      const k = IMPORT_HEADERS[String(v || '').replace(/\s+/g, ' ').trim().toLowerCase()];
      if (k && !(k in col)) col[k] = i;
    });
    if (!(col.expires >= 0 || col.start >= 0) || !((col.last_name >= 0 && col.first_name >= 0) || col.fio >= 0 || col.iin >= 0)) {
      return res.status(400).json({ error: 'missing_columns', message: 'Нужны колонки: «Фамилия» + «Имя» (или «ФИО», или «ИИН») и «Допуск до» (или «Дата начала»). Скачайте бланк.' });
    }
    const raw = (row, f) => (f in col ? row[col[f]] : '');
    const txt = (row, f) => String(raw(row, f) ?? '').replace(/\s+/g, ' ').trim();

    // Все сотрудники один раз — для быстрого поиска
    const users = (await query(
      `SELECT id, last_name, first_name, iin, tco_badge, object, department, position, role, employment_status, active
         FROM users WHERE role = 'employee'`
    )).rows;
    const byIin = new Map(), byName = new Map(), byLoose = new Map(), bySkel = new Map();
    const push = (m, k, u) => { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(u); };
    users.forEach((u) => {
      push(byIin, String(u.iin || '').replace(/\D/g, ''), u);
      push(byName, normalizeFio(`${u.last_name} ${u.first_name}`), u);
      push(byLoose, looseFio(`${u.last_name} ${u.first_name}`), u);
      // и «Фамилия Имя», и «Имя Фамилия» — на сайте у части сотрудников поля перепутаны
      const k1 = skeletonFio(`${u.last_name} ${u.first_name}`), k2 = skeletonFio(`${u.first_name} ${u.last_name}`);
      push(bySkel, k1, u);
      if (k2 !== k1) push(bySkel, k2, u);
    });
    const pick = (list) => {
      if (!list || !list.length) return [];
      if (list.length === 1) return list;
      const act = list.filter((u) => Number(u.active) === 1 && (u.employment_status || 'active') === 'active');
      return act.length ? act : list;
    };

    const periods = await mb.positionPeriods();
    const structIndex = new Map((await structureRows()).map((x) => [keyOf(x.object, x.department, x.position), x]));
    const posSkipped = new Set();
    const today = mb.todayYmd();
    const posAdded = new Map();     // key -> {object, department, position, period}
    const errors = [], notFound = [];
    let updated = 0, skipped = 0;
    const seen = new Set();

    for (let r = h + 1; r < sheetRows.length; r++) {
      const row = sheetRows[r] || [];
      const rowNum = r + 1;
      let last = txt(row, 'last_name'), first = txt(row, 'first_name');
      const fio = txt(row, 'fio');
      if ((!last || !first) && fio) { const p = fio.split(' '); last = last || p[0] || ''; first = first || p[1] || ''; }
      let iin = txt(row, 'iin').replace(/\D/g, '');
      if (iin && iin.length >= 10 && iin.length < 12) iin = iin.padStart(12, '0');
      if (!last && !first && !iin) continue;
      const label = `${last} ${first}`.trim() || `ИИН ${iin}`;
      try {
        let expires = null, start = null;
        try { expires = parseImportDate(raw(row, 'expires')); start = parseImportDate(raw(row, 'start')); }
        catch (_) { errors.push(`Строка ${rowNum}: «${label}» — не удалось прочитать дату`); continue; }
        if (!expires && !start) { skipped++; errors.push(`Строка ${rowNum}: «${label}» — нет даты допуска, пропущено`); continue; }

        let found = iin ? pick(byIin.get(iin)) : [];
        if (!found.length && last && first) found = pick(byName.get(normalizeFio(`${last} ${first}`)));
        if (!found.length && last && first) found = pick(byLoose.get(looseFio(`${last} ${first}`)));
        if (!found.length && last && first) found = pick(bySkel.get(skeletonFio(`${last} ${first}`)));
        if (!found.length) { notFound.push({ row: rowNum, name: label, iin, position: txt(row, 'pos') }); continue; }
        if (found.length > 1) found = narrowNamesakes(found, { badge: txt(row, 'badge'), dept: txt(row, 'dept'), pos: txt(row, 'pos') });
        if (found.length > 1) { errors.push(`Строка ${rowNum}: «${label}» — ${NAMESAKE_ERROR}. Совпали: ${namesakesHint(found)}`); continue; }
        const u = found[0];
        if (!inScope(req.user, u)) { errors.push(`Строка ${rowNum}: «${label}» вне вашей зоны доступа`); continue; }
        if (seen.has(u.id)) { errors.push(`Строка ${rowNum}: «${label}» уже был выше в файле — взята первая строка`); continue; }
        seen.add(u.id);

        const key = keyOf(u.object, u.department, u.position);
        const rowPeriod = validPeriod(txt(row, 'period')) || 12;
        if (!periods.has(key) && markPositions && String(u.position || '').trim()) {
          const canon = structIndex.get(key);
          if (canon) {
            periods.set(key, rowPeriod);
            posAdded.set(key, { ...canon, period: rowPeriod });
          } else {
            // Должности нет в справочнике «Объект → Отдел → Должность» — отметить её нельзя
            // (при сохранении «Должностей и периодичности» она бы пропала). Книжка вносится «вне должности».
            posSkipped.add(`${u.position} (${u.object || '—'} / ${u.department || '—'})`);
          }
        }
        const required = periods.has(key);
        const period = required ? periods.get(key) : rowPeriod;
        // «Допуск до» из журнала сохраняем как есть — это и есть срок. Дата прохождения = срок минус период
        // (полугодовой: допуск до 17.01.2027 → прошёл 17.07.2026; годовой → 17.01.2026).
        // Если в файле есть «Допуск до» — он и есть срок (как в журнале), даже если дата начала тоже дана
        const fixedExpiry = expires || null;
        if (!start) start = mb.addMonths(expires, -period);
        if (start > today) {
          errors.push(`Строка ${rowNum}: «${label}» — допуск до ${expires}, а период ${period} мес.: получается, медосмотр ещё не пройден. Проверьте дату или период должности`);
          continue;
        }
        const noteGiven = 'note' in col;
        await query(
          `INSERT INTO medbook_records (user_id, start_date, period_months, manual, updated_by, updated_at, note, expires_date)
           VALUES ($1, $2, $3, $4, $5, NOW(), $6, $8)
           ON CONFLICT (user_id) DO UPDATE SET start_date = EXCLUDED.start_date, period_months = EXCLUDED.period_months,
             manual = EXCLUDED.manual, updated_by = EXCLUDED.updated_by, updated_at = NOW(), expires_date = EXCLUDED.expires_date,
             note = CASE WHEN $7 THEN EXCLUDED.note ELSE medbook_records.note END`,
          [u.id, start, period, !required, req.user.id, noteGiven ? cleanNote(txt(row, 'note')) : null, noteGiven, fixedExpiry]
        );
        updated++;
      } catch (rowErr) {
        errors.push(`Строка ${rowNum}: «${label}» — ${rowErr.message}`);
      }
    }

    for (const [k, v] of posAdded) {
      await query(
        `INSERT INTO medbook_positions (object, department, position, key, period_months) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (key) DO NOTHING`,
        [v.object, v.department, v.position, k, v.period]
      );
    }
    // Записи, внесённые раньше «вне должности», для только что отмеченных должностей становятся обычными
    if (posAdded.size) {
      await query(
        `UPDATE medbook_records r SET manual = FALSE
           FROM users u
          WHERE u.id = r.user_id AND r.manual = TRUE
            AND (lower(regexp_replace(trim(COALESCE(u.object,'')), '\\s+', ' ', 'g')) || '|' ||
                 lower(regexp_replace(trim(COALESCE(u.department,'')), '\\s+', ' ', 'g')) || '|' ||
                 lower(regexp_replace(trim(COALESCE(u.position,'')), '\\s+', ' ', 'g'))) = ANY($1::text[])`,
        [[...posAdded.keys()]]
      );
    }

    const positionsAdded = [...posAdded.values()].map((v) => ({ object: v.object, department: v.department, position: v.position, period_months: v.period }));
    await logAction(req, 'medbook_imported', {
      entityType: 'medbook', entityName: String(req.file.originalname || ''),
      details: { updated, not_found: notFound.length, errors: errors.length, positions_added: positionsAdded.length }
    });
    res.json({ updated, skipped, positions_added: positionsAdded, positions_not_in_structure: [...posSkipped], not_found: notFound, errors });
  } catch (e) {
    console.error('medbook import failed:', e);
    res.status(500).json({ error: 'import_failed', message: 'Не удалось выполнить загрузку: ' + e.message });
  }
});

// Общие помощники для routes/medexams.js (ежегодный медосмотр): поиск сотрудника по ФИО, даты, зона ассистента
router.helpers = { skeletonFio, looseFio, parseImportDate, cleanNote, inScope };

module.exports = router;
