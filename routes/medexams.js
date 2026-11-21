// ЕЖЕГОДНЫЙ МЕДОСМОТР — обязателен ВСЕМ действующим сотрудникам, проходится раз в 12 месяцев.
// В отличие от санкнижек, должности не настраиваются: в списке все сотрудники (в зоне ассистента — только его).
//
//   GET    /api/medexams/overview              — все сотрудники + статус медосмотра + статистика
//   GET    /api/medexams/user/:id              — медосмотр одного сотрудника
//   GET    /api/medexams/me                    — то же для вошедшего сотрудника
//   PUT    /api/medexams/user/:id              — внести/обновить: expires_date («действует до») ИЛИ exam_date (дата прохождения)
//   DELETE /api/medexams/user/:id              — сбросить
//   GET    /api/medexams/import-template.xlsx  — бланк
//   POST   /api/medexams/import                — массовая загрузка из Excel
//
// Главное поле — «действует до» (expires_date): как в журналах. Дата прохождения = «действует до» минус 12 мес.
const express = require('express');
const router = express.Router();
const fs = require('fs');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const { query } = require('../db');
const { authRequired, requireRole } = require('./auth');
const { requireAdminFunction } = require('../lib/adminFunctions');
const { logAction } = require('../lib/audit');
const { splitMulti, scopedFilter } = require('../lib/multiFilter');
const { makeUploader } = require('../upload');
const { normalizeFio, computeFioFields } = require('../lib/fio');
const mb = require('../lib/medbook');
const { skeletonFio, looseFio, parseImportDate, cleanNote, inScope } = require('./medbooks').helpers;

const upload = makeUploader('imports');
const PERIOD = 12;
const STAFF = [requireRole('admin', 'assistant', 'superadmin'), requireAdminFunction('medexam')];

function entryOf(u, today) {
  const expires = u.me_expires || null;
  let st = { status: 'no_date', expires: null, days_left: null };
  if (expires) {
    const days = Math.round((Date.parse(expires + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
    st = { status: days < 0 ? 'overdue' : days <= mb.SOON_DAYS ? 'soon' : 'valid', expires, days_left: days };
  }
  return {
    user_id: Number(u.id), last_name: u.last_name, first_name: u.first_name,
    object: u.object, department: u.department, position: u.position, staff_category: u.staff_category || 'employee',
    exam_date: expires ? (u.me_exam || mb.addMonths(expires, -PERIOD)) : null,
    note: u.me_note || '',
    ...st
  };
}
const SELECT = `
  SELECT u.id, u.last_name, u.first_name, u.object, u.department, u.position, u.staff_category,
         to_char(r.exam_date, 'YYYY-MM-DD') AS me_exam, to_char(r.expires_date, 'YYYY-MM-DD') AS me_expires, r.note AS me_note
    FROM users u LEFT JOIN medexam_records r ON r.user_id = u.id
   WHERE u.role = 'employee' AND u.active = 1 AND COALESCE(u.employment_status, 'active') = 'active'`;

function summarize(rows) {
  const s = { total: rows.length, valid: 0, soon: 0, overdue: 0, no_date: 0 };
  rows.forEach((e) => { s[e.status] = (s[e.status] || 0) + 1; });
  return s;
}

router.get('/overview', authRequired, STAFF, async (req, res) => {
  try {
    const reqObjs = splitMulti(req.query.object), reqDeps = splitMulti(req.query.department);
    const scope = scopedFilter(req.user, reqObjs, reqDeps);
    const empty = () => res.json({ rows: [], stats: summarize([]) });
    if (scope.noAccess) return empty();
    if (req.user.role === 'assistant' && ((reqObjs.length && !scope.objects.length) || (reqDeps.length && !scope.departments.length))) return empty();
    const params = [];
    let sql = SELECT;
    if (scope.objects.length) { params.push(scope.objects); sql += ` AND u.object = ANY($${params.length}::text[])`; }
    if (scope.departments.length) { params.push(scope.departments); sql += ` AND u.department = ANY($${params.length}::text[])`; }
    const cat = ['manager', 'specialist', 'employee'].includes(req.query.category) ? req.query.category : '';
    if (cat) { params.push(cat); sql += ` AND COALESCE(u.staff_category, 'employee') = $${params.length}`; }
    sql += ' ORDER BY u.last_name, u.first_name';
    const today = mb.todayYmd();
    const rows = (await query(sql, params)).rows.map((u) => entryOf(u, today));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ rows, stats: summarize(rows) });
  } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

async function sendUser(res, userId) {
  const u = (await query(SELECT.replace("WHERE u.role = 'employee' AND u.active = 1 AND COALESCE(u.employment_status, 'active') = 'active'", "WHERE u.id = $1 AND u.role = 'employee'"), [userId])).rows[0];
  res.setHeader('Cache-Control', 'no-store');
  res.json(u ? { applicable: true, ...entryOf(u, mb.todayYmd()) } : { applicable: false });
}
async function loadTarget(req, res) {
  const u = (await query('SELECT id, last_name, first_name, object, department, role FROM users WHERE id = $1', [req.params.id])).rows[0];
  if (!u || u.role !== 'employee') { res.status(404).json({ error: 'not_found', message: 'Сотрудник не найден' }); return null; }
  if (!inScope(req.user, u)) { res.status(403).json({ error: 'forbidden_scope', message: 'Сотрудник вне вашей зоны' }); return null; }
  return u;
}

router.get('/me', authRequired, async (req, res) => {
  try { await sendUser(res, req.user.id); } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});
router.get('/user/:id', authRequired, STAFF, async (req, res) => {
  try { const u = await loadTarget(req, res); if (u) await sendUser(res, u.id); }
  catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

// Из «действует до» или «даты прохождения» -> { exam, expires } (или текст ошибки)
function resolveDates(expiresIn, examIn, today) {
  let expires = mb.isYmd(expiresIn) ? expiresIn : null;
  let exam = mb.isYmd(examIn) ? examIn : null;
  if (!expires && !exam) return { error: 'Укажите «действует до» или дату медосмотра' };
  if (!expires) expires = mb.addMonths(exam, PERIOD);
  if (!exam) exam = mb.addMonths(expires, -PERIOD);
  if (exam > today) return { error: `Действует до ${expires} — больше чем на год вперёд, проверьте дату` };
  return { exam, expires };
}

router.put('/user/:id', authRequired, STAFF, async (req, res) => {
  try {
    const u = await loadTarget(req, res); if (!u) return;
    const b = req.body || {};
    const d = resolveDates(String(b.expires_date || ''), String(b.exam_date || ''), mb.todayYmd());
    if (d.error) return res.status(400).json({ error: 'bad_date', message: d.error });
    const noteGiven = Object.prototype.hasOwnProperty.call(b, 'note');
    await query(
      `INSERT INTO medexam_records (user_id, exam_date, expires_date, note, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (user_id) DO UPDATE SET exam_date = EXCLUDED.exam_date, expires_date = EXCLUDED.expires_date,
         updated_by = EXCLUDED.updated_by, updated_at = NOW(), note = CASE WHEN $6 THEN EXCLUDED.note ELSE medexam_records.note END`,
      [u.id, d.exam, d.expires, noteGiven ? cleanNote(b.note) : null, req.user.id, noteGiven]
    );
    await logAction(req, 'medexam_saved', { entityType: 'user', entityId: u.id, entityName: `${u.last_name} ${u.first_name}`.trim(), details: { exam_date: d.exam, expires_date: d.expires } });
    await sendUser(res, u.id);
  } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

router.delete('/user/:id', authRequired, STAFF, async (req, res) => {
  try {
    const u = await loadTarget(req, res); if (!u) return;
    await query('DELETE FROM medexam_records WHERE user_id = $1', [u.id]);
    await logAction(req, 'medexam_removed', { entityType: 'user', entityId: u.id, entityName: `${u.last_name} ${u.first_name}`.trim() });
    await sendUser(res, u.id);
  } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

// ---------- Excel ----------
router.get('/import-template.xlsx', authRequired, STAFF, async (req, res) => {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Медосмотр');
    ws.columns = [
      { header: 'Фамилия', key: 'l', width: 20 }, { header: 'Имя', key: 'f', width: 18 }, { header: 'ИИН', key: 'i', width: 15 },
      { header: 'Действует до', key: 'e', width: 14 }, { header: 'Дата медосмотра', key: 'x', width: 16 }, { header: 'Примечание', key: 'n', width: 40 }
    ];
    ws.getRow(1).font = { bold: true };
    ws.getColumn('i').numFmt = '@';
    ws.getColumn('e').numFmt = 'dd.mm.yyyy';
    ws.getColumn('x').numFmt = 'dd.mm.yyyy';
    ws.addRow({ l: 'Иванова', f: 'Мария', e: new Date(Date.UTC(2027, 2, 15)), n: 'пример — удалите строку' });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    const notes = wb.addWorksheet('Инструкция');
    notes.columns = [{ key: 'a', width: 110 }];
    ['Ежегодный медосмотр — обязателен всем сотрудникам, раз в 12 месяцев.',
      '1. Одна строка — один сотрудник (ищется по ИИН, затем по Фамилии и Имени; можно одной колонкой «ФИО»).',
      '2. Заполните «Действует до» (как в журнале) ИЛИ «Дата медосмотра» — вторую дату сайт посчитает сам (± 12 мес.).',
      '3. «Примечание» — где проходил, заключение и т.п.'].forEach((l) => notes.addRow([l]));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="medexam_template.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { res.status(500).json({ error: 'template_failed', details: e.message }); }
});

const { narrowNamesakes, namesakesHint, NAMESAKE_ERROR } = require('../lib/namesakes');
const HEAD = {
  'фамилия': 'last_name', 'имя': 'first_name', 'фио': 'fio', 'ф.и.о.': 'fio', 'ф.и.о': 'fio', 'иин': 'iin',
  'действует до': 'expires', 'допуск до': 'expires', 'срок действия': 'expires', 'годен до': 'expires', 'срок допуска': 'expires',
  'дата медосмотра': 'exam', 'медосмотр': 'exam', 'дата прохождения': 'exam', 'пройден': 'exam',
  'примечание': 'note', 'примечания': 'note',
  // точные ФИО, как они сейчас записаны на сайте (для надёжного поиска), и № пропуска
  'фамилия на сайте': 'site_last', 'имя на сайте': 'site_first',
  'номер пропуска': 'badge', '№ пропуска': 'badge', 'пропуск': 'badge', '№ пропуска тшо': 'badge',
  'отдел': 'dept', 'департамент': 'dept', 'должность': 'pos', 'должность на сайте': 'pos'
};

router.post('/import', authRequired, STAFF, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file', message: 'Файл не выбран' });
  // «Обновить ФИО и № пропуска на сайте как в файле» — только админ/суперадмин
  const updateNames = ['admin', 'superadmin'].includes(req.user.role) && ['1', 'true', 'on'].includes(String((req.body && req.body.update_names) || '').toLowerCase());
  let sheet;
  try {
    const wb = XLSX.readFile(req.file.path, { cellDates: true, raw: true });
    sheet = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true });
  } catch (e) {
    return res.status(400).json({ error: 'invalid_file', message: 'Не удалось прочитать файл (.xlsx без пароля).' });
  } finally { try { fs.unlinkSync(req.file.path); } catch (_) { /* ignore */ } }
  try {
    const h = sheet.findIndex((r) => (r || []).some((v) => ['фио', 'фамилия', 'ф.и.о.', 'ф.и.о'].includes(String(v || '').trim().toLowerCase())));
    if (h < 0) return res.status(400).json({ error: 'missing_columns', message: 'Нужны колонки «Фамилия» + «Имя» (или «ФИО») и «Действует до» или «Дата медосмотра». Скачайте бланк.' });
    const col = {};
    sheet[h].forEach((v, i) => { const k = HEAD[String(v || '').replace(/\s+/g, ' ').trim().toLowerCase()]; if (k && !(k in col)) col[k] = i; });
    if (!(col.expires >= 0 || col.exam >= 0)) return res.status(400).json({ error: 'missing_columns', message: 'Нужна колонка «Действует до» или «Дата медосмотра».' });
    const txt = (row, f) => String((f in col ? row[col[f]] : '') ?? '').replace(/\s+/g, ' ').trim();

    const users = (await query(`SELECT id, last_name, first_name, iin, tco_badge, object, department, position, active, employment_status FROM users WHERE role = 'employee'`)).rows;
    const maps = { iin: new Map(), name: new Map(), loose: new Map(), skel: new Map() };
    const push = (m, k, u) => { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(u); };
    users.forEach((u) => {
      push(maps.iin, String(u.iin || '').replace(/\D/g, ''), u);
      push(maps.name, normalizeFio(`${u.last_name} ${u.first_name}`), u);
      push(maps.loose, looseFio(`${u.last_name} ${u.first_name}`), u);
      const k1 = skeletonFio(`${u.last_name} ${u.first_name}`), k2 = skeletonFio(`${u.first_name} ${u.last_name}`);
      push(maps.skel, k1, u); if (k2 !== k1) push(maps.skel, k2, u);
    });
    const pick = (list) => {
      if (!list || list.length < 2) return list || [];
      const act = list.filter((u) => Number(u.active) === 1 && (u.employment_status || 'active') === 'active');
      return act.length ? act : list;
    };
    const today = mb.todayYmd();
    const errors = [], notFound = [], seen = new Set();
    let updated = 0, renamed = 0;
    for (let r = h + 1; r < sheet.length; r++) {
      const row = sheet[r] || [];
      let last = txt(row, 'last_name'), first = txt(row, 'first_name');
      const fio = txt(row, 'fio');
      if ((!last || !first) && fio) { const p = fio.split(' '); last = last || p[0] || ''; first = first || p[1] || ''; }
      let iin = txt(row, 'iin').replace(/\D/g, '');
      if (iin.length >= 10 && iin.length < 12) iin = iin.padStart(12, '0');
      if (!last && !first && !iin) continue;
      const label = `${last} ${first}`.trim() || `ИИН ${iin}`;
      let expires = null, exam = null;
      try { expires = parseImportDate(col.expires >= 0 ? row[col.expires] : ''); exam = parseImportDate(col.exam >= 0 ? row[col.exam] : ''); }
      catch (_) { errors.push(`Строка ${r + 1}: «${label}» — не удалось прочитать дату`); continue; }
      if (!expires && !exam) { errors.push(`Строка ${r + 1}: «${label}» — нет даты, пропущено`); continue; }
      const siteLast = txt(row, 'site_last'), siteFirst = txt(row, 'site_first');
      let found = iin ? pick(maps.iin.get(iin)) : [];
      if (!found.length && siteLast && siteFirst) found = pick(maps.name.get(normalizeFio(`${siteLast} ${siteFirst}`)));
      if (!found.length && last && first) found = pick(maps.name.get(normalizeFio(`${last} ${first}`)));
      if (!found.length && last && first) found = pick(maps.loose.get(looseFio(`${last} ${first}`)));
      if (!found.length && last && first) found = pick(maps.skel.get(skeletonFio(`${last} ${first}`)));
      if (!found.length) { notFound.push({ row: r + 1, name: label, iin }); continue; }
      if (found.length > 1) found = narrowNamesakes(found, { badge: txt(row, 'badge'), dept: txt(row, 'dept'), pos: txt(row, 'pos') });
      if (found.length > 1) { errors.push(`Строка ${r + 1}: «${label}» — ${NAMESAKE_ERROR}. Совпали: ${namesakesHint(found)}`); continue; }
      const u = found[0];
      if (!inScope(req.user, u)) { errors.push(`Строка ${r + 1}: «${label}» вне вашей зоны доступа`); continue; }
      if (seen.has(u.id)) { errors.push(`Строка ${r + 1}: «${label}» уже был выше — взята первая строка`); continue; }
      seen.add(u.id);
      const d = resolveDates(expires || '', exam || '', today);
      if (d.error) { errors.push(`Строка ${r + 1}: «${label}» — ${d.error}`); continue; }
      const noteGiven = 'note' in col;
      await query(
        `INSERT INTO medexam_records (user_id, exam_date, expires_date, note, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (user_id) DO UPDATE SET exam_date = EXCLUDED.exam_date, expires_date = EXCLUDED.expires_date,
           updated_by = EXCLUDED.updated_by, updated_at = NOW(), note = CASE WHEN $6 THEN EXCLUDED.note ELSE medexam_records.note END`,
        [u.id, d.exam, d.expires, noteGiven ? cleanNote(txt(row, 'note')) : null, req.user.id, noteGiven]
      );
      updated++;
      if (updateNames && last && first) {
        const badge = txt(row, 'badge').replace(/\s+/g, '');
        const changed = normalizeFio(`${u.last_name} ${u.first_name}`) !== normalizeFio(`${last} ${first}`) || `${u.last_name} ${u.first_name}` !== `${last} ${first}`;
        if (changed || badge) {
          const f = computeFioFields(last, first);
          await query(
            `UPDATE users SET last_name = $2, first_name = $3, full_name_normalized = $4, full_name_translit = $5,
                    tco_badge = COALESCE(NULLIF($6, ''), tco_badge) WHERE id = $1`,
            [u.id, last, first, f.normalized, f.translit, badge]
          );
          if (changed) renamed++;
        }
      }
    }
    await logAction(req, 'medexam_imported', { entityType: 'medexam', entityName: String(req.file.originalname || ''), details: { updated, renamed, not_found: notFound.length, errors: errors.length } });
    res.json({ updated, renamed, not_found: notFound, errors });
  } catch (e) {
    res.status(500).json({ error: 'import_failed', message: 'Не удалось выполнить загрузку: ' + e.message });
  }
});

module.exports = router;
