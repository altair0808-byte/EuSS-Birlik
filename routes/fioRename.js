// МАССОВОЕ ИСПРАВЛЕНИЕ ФИО (например, латиница → кириллица) и № пропуска ТШО из Excel.
// Админ / суперадмин.
//
//   GET  /api/fio-rename/template.xlsx — все сотрудники: «Фамилия сейчас», «Имя сейчас», пустые «Новая фамилия», «Новое имя», «Номер пропуска»
//   POST /api/fio-rename               — загрузить заполненный файл; dry_run=1 — только показать, что изменится
//
// Сотрудник ищется точно по «Фамилия сейчас» + «Имя сейчас» (или по ИИН, если колонка есть).
// Пустые «Новая фамилия» / «Новое имя» — строка не меняется (кроме № пропуска, если он указан).
const express = require('express');
const router = express.Router();
const fs = require('fs');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const { query } = require('../db');
const { authRequired, requireRole } = require('./auth');
const { makeUploader } = require('../upload');
const { normalizeFio, computeFioFields } = require('../lib/fio');
const { logAction } = require('../lib/audit');

const upload = makeUploader('imports');
const ADM = [authRequired, requireRole('admin', 'superadmin')];
const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

router.get('/template.xlsx', ADM, async (req, res) => {
  try {
    const rows = (await query(`SELECT last_name, first_name, iin, object, department, position, tco_badge FROM users
                                WHERE role = 'employee' ORDER BY last_name, first_name`)).rows;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('ФИО');
    ws.columns = [
      { header: 'Фамилия сейчас', key: 'l', width: 22 }, { header: 'Имя сейчас', key: 'f', width: 18 },
      { header: 'Новая фамилия', key: 'nl', width: 22 }, { header: 'Новое имя', key: 'nf', width: 18 },
      { header: 'Номер пропуска', key: 'b', width: 15 }, { header: 'ИИН', key: 'i', width: 15 },
      { header: 'Отдел', key: 'd', width: 24 }, { header: 'Должность', key: 'p', width: 30 }
    ];
    ws.getRow(1).font = { bold: true };
    rows.forEach((r) => ws.addRow({ l: r.last_name, f: r.first_name, b: r.tco_badge || '', i: r.iin || '', d: r.department, p: r.position }));
    ws.getColumn('b').numFmt = '@'; ws.getColumn('i').numFmt = '@';
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="fio_rename.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { res.status(500).json({ error: 'template_failed', details: e.message }); }
});

const HEAD = {
  'фамилия сейчас': 'cur_last', 'имя сейчас': 'cur_first', 'фамилия на сайте': 'cur_last', 'имя на сайте': 'cur_first',
  'новая фамилия': 'new_last', 'новое имя': 'new_first', 'номер пропуска': 'badge', '№ пропуска': 'badge', 'иин': 'iin'
};

router.post('/', ADM, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file', message: 'Файл не выбран' });
  const dry = ['1', 'true', 'on'].includes(String((req.body && req.body.dry_run) || '').toLowerCase());
  let sheet;
  try {
    const wb = XLSX.readFile(req.file.path, { raw: true });
    sheet = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
  } catch (e) {
    return res.status(400).json({ error: 'invalid_file', message: 'Не удалось прочитать файл (.xlsx без пароля).' });
  } finally { try { fs.unlinkSync(req.file.path); } catch (_) { /* ignore */ } }
  const col = {};
  (sheet[0] || []).forEach((v, i) => { const k = HEAD[clean(v).toLowerCase()]; if (k && !(k in col)) col[k] = i; });
  if (!(col.cur_last >= 0 && col.cur_first >= 0 && col.new_last >= 0 && col.new_first >= 0)) {
    return res.status(400).json({ error: 'missing_columns', message: 'Нужны колонки: «Фамилия сейчас», «Имя сейчас», «Новая фамилия», «Новое имя». Скачайте бланк.' });
  }
  const get = (row, k) => (k in col ? clean(row[col[k]]) : '');
  try {
    const users = (await query(`SELECT id, last_name, first_name, iin, tco_badge FROM users WHERE role = 'employee'`)).rows;
    const byName = new Map(), byIin = new Map();
    users.forEach((u) => {
      const k = normalizeFio(`${u.last_name} ${u.first_name}`);
      if (!byName.has(k)) byName.set(k, []); byName.get(k).push(u);
      if (u.iin) byIin.set(String(u.iin).replace(/\D/g, ''), u);
    });
    const changes = [], errors = [], seen = new Set();
    for (let r = 1; r < sheet.length; r++) {
      const row = sheet[r] || [];
      const cl = get(row, 'cur_last'), cf = get(row, 'cur_first');
      const nl = get(row, 'new_last'), nf = get(row, 'new_first');
      const badge = get(row, 'badge').replace(/\s+/g, '');
      if (!cl && !cf) continue;
      if (!nl && !nf && !badge) continue;
      const iin = get(row, 'iin').replace(/\D/g, '');
      let u = iin && byIin.get(iin.padStart(12, '0'));
      if (!u) {
        const list = byName.get(normalizeFio(`${cl} ${cf}`)) || [];
        if (list.length > 1) { errors.push(`Строка ${r + 1}: на сайте несколько «${cl} ${cf}» — укажите ИИН`); continue; }
        u = list[0];
      }
      if (!u) { errors.push(`Строка ${r + 1}: «${cl} ${cf}» не найден на сайте`); continue; }
      if (seen.has(u.id)) { errors.push(`Строка ${r + 1}: «${cl} ${cf}» уже был выше`); continue; }
      seen.add(u.id);
      const last = nl || u.last_name, first = nf || u.first_name;
      const nameChanged = last !== u.last_name || first !== u.first_name;
      const badgeChanged = !!badge && badge !== String(u.tco_badge || '');
      if (!nameChanged && !badgeChanged) continue;
      changes.push({ id: u.id, from: `${u.last_name} ${u.first_name}`, to: `${last} ${first}`, badge: badgeChanged ? badge : '' });
      if (!dry) {
        const f = computeFioFields(last, first);
        await query(
          `UPDATE users SET last_name = $2, first_name = $3, full_name_normalized = $4, full_name_translit = $5,
                  tco_badge = COALESCE(NULLIF($6, ''), tco_badge) WHERE id = $1`,
          [u.id, last, first, f.normalized, f.translit, badgeChanged ? badge : '']
        );
      }
    }
    if (!dry && changes.length) {
      await logAction(req, 'fio_renamed', { entityType: 'users', entityName: String(req.file.originalname || ''), details: { changed: changes.length } });
    }
    res.json({ dry_run: dry, changed: changes.length, changes: changes.slice(0, 1000), errors });
  } catch (e) {
    res.status(500).json({ error: 'rename_failed', message: 'Не удалось выполнить: ' + e.message });
  }
});

module.exports = router;
