// ПОРЯДОК В ДОЛЖНОСТЯХ: массовая замена должностей (и при необходимости отдела) у сотрудников из Excel.
// Только суперадмин.
//
//   GET  /api/positions/remap-template.xlsx — текущие должности сотрудников (объект / отдел / должность / сколько человек)
//                                             с пустыми колонками «Новый отдел», «Новая должность»
//   POST /api/positions/remap               — загрузить заполненный файл; dry_run=1 — только показать, что изменится
//
// Что делает замена «Объект / Отдел / Должность → Новый отдел / Новая должность»:
//   • у всех сотрудников с такой тройкой меняются отдел и должность;
//   • новая должность добавляется в справочник должностей и в структуру «Объект → Отдел → Должность», если её там нет;
//   • привязки курсов к должностям (course_positions) и «должности с мед. книжкой» (medbook_positions) переезжают
//     на новую должность — ничего не теряется;
//   • старая должность убирается из структуры этого отдела, если у неё больше не осталось сотрудников.
const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const fs = require('fs');
const { query, pool } = require('../db');
const { authRequired, requireRole } = require('./auth');
const { makeUploader } = require('../upload');
const { keyOf } = require('../lib/positionCourses');
const { logAction } = require('../lib/audit');

const upload = makeUploader('imports');
const SU = [authRequired, requireRole('superadmin')];
const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

async function loadDict(client) {
  const r = await client.query('SELECT positions_list, org_structure, objects_list FROM settings WHERE id = 1');
  const row = r.rows[0] || {};
  return {
    positions: Array.isArray(row.positions_list) ? row.positions_list : [],
    structure: Array.isArray(row.org_structure) ? row.org_structure : [],
    objects: Array.isArray(row.objects_list) ? row.objects_list : []
  };
}
const posName = (p) => clean(typeof p === 'string' ? p : p && p.ru);
function inStructure(structure, object, department, position) {
  const o = structure.find((x) => clean(x.object) === object);
  const d = o && (o.departments || []).find((x) => clean(x.name) === department);
  return !!(d && (d.positions || []).some((p) => posName(p).toLowerCase() === position.toLowerCase()));
}

router.get('/remap-template.xlsx', SU, async (req, res) => {
  try {
    const [rows, dict] = await Promise.all([
      query(`SELECT COALESCE(object,'') AS object, COALESCE(department,'') AS department, COALESCE(position,'') AS position, COUNT(*)::int AS n
               FROM users WHERE role = 'employee'
              GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`),
      loadDict(pool)
    ]);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Должности');
    ws.columns = [
      { header: 'Объект', key: 'object', width: 14 },
      { header: 'Отдел', key: 'department', width: 26 },
      { header: 'Должность', key: 'position', width: 46 },
      { header: 'Сотрудников', key: 'n', width: 13 },
      { header: 'Есть в справочнике', key: 'known', width: 18 },
      { header: 'Новый отдел', key: 'new_department', width: 26 },
      { header: 'Новая должность', key: 'new_position', width: 46 }
    ];
    ws.getRow(1).font = { bold: true };
    rows.rows.forEach((r) => ws.addRow({ ...r, known: inStructure(dict.structure, clean(r.object), clean(r.department), clean(r.position)) ? 'да' : 'НЕТ' }));
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = 'A1:G1';
    const notes = wb.addWorksheet('Инструкция');
    notes.columns = [{ key: 'a', width: 110 }];
    [
      'Как навести порядок в должностях:',
      '1. Каждая строка — одна должность, как она сейчас записана у сотрудников (объект / отдел / должность).',
      '2. Чтобы заменить — впишите «Новая должность» (и при необходимости «Новый отдел»). Пусто — строка не меняется.',
      '3. «Новый отдел» пустой — отдел остаётся прежним.',
      '4. Загрузите файл: Сотрудники → «🔁 Порядок в должностях». Сначала нажмите «Проверить» — сайт покажет, что изменится, ничего не меняя.',
      '5. При замене курсы по должностям и отметки «санкнижка обязательна» переносятся на новую должность.',
      '6. Новая должность сама добавится в справочник и в структуру отдела; старая уберётся из структуры, если у неё не осталось сотрудников.'
    ].forEach((l) => notes.addRow([l]));
    notes.getRow(1).font = { bold: true };
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="positions_remap.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { res.status(500).json({ error: 'template_failed', details: e.message }); }
});

const HEAD = {
  'объект': 'object', 'отдел': 'department', 'должность': 'position',
  'новый отдел': 'new_department', 'новая должность': 'new_position'
};

router.post('/remap', SU, upload.single('file'), async (req, res) => {
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
  if (!(col.position >= 0) || !(col.new_position >= 0) || !(col.department >= 0)) {
    return res.status(400).json({ error: 'missing_columns', message: 'Нужны колонки: Объект, Отдел, Должность, Новый отдел, Новая должность. Скачайте бланк.' });
  }
  const get = (row, k) => (k in col ? clean(row[col[k]]) : '');
  const plan = [];
  const errors = [];
  for (let i = 1; i < sheet.length; i++) {
    const row = sheet[i] || [];
    const object = get(row, 'object'), department = get(row, 'department'), position = get(row, 'position');
    const newPos = get(row, 'new_position');
    const newDep = get(row, 'new_department') || department;
    if (!newPos && newDep === department) continue;
    const target = { object, department: newDep, position: newPos || position };
    if (!target.position) { errors.push(`Строка ${i + 1}: пустая новая должность`); continue; }
    if (target.department === department && target.position === position) continue;
    plan.push({ row: i + 1, from: { object, department, position }, to: target });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dict = await loadDict(client);
    const changes = [];
    for (const p of plan) {
      const { from, to } = p;
      // Написание берём из справочника, если там есть та же должность другим регистром («Старший Повар» / «Старший повар»)
      const canon = dict.positions.map(posName).find((x) => x.toLowerCase() === to.position.toLowerCase());
      if (canon) to.position = canon;
      if (to.department === from.department && to.position === from.position) continue;
      const r = await client.query(
        `${dry ? 'SELECT COUNT(*)::int AS n FROM users' : 'UPDATE users SET department = $4, position = $5'}
          WHERE role = 'employee' AND trim(COALESCE(object,'')) = $1 AND trim(COALESCE(department,'')) = $2 AND trim(COALESCE(position,'')) = $3
          ${dry ? '' : 'RETURNING id'}`,
        dry ? [from.object, from.department, from.position] : [from.object, from.department, from.position, to.department, to.position]
      );
      const n = dry ? r.rows[0].n : r.rowCount;
      if (!n) { errors.push(`Строка ${p.row}: нет сотрудников «${from.position}» (${from.object} / ${from.department})`); continue; }
      changes.push({ from, to, count: n });
      if (dry) continue;

      // справочник и структура
      if (!dict.positions.some((x) => posName(x) === to.position)) dict.positions.push({ ru: to.position, kz: '' });
      let o = dict.structure.find((x) => clean(x.object) === to.object);
      if (!o && to.object) { o = { object: to.object, departments: [] }; dict.structure.push(o); if (!dict.objects.includes(to.object)) dict.objects.push(to.object); }
      if (o) {
        let d = (o.departments || (o.departments = [])).find((x) => clean(x.name) === to.department);
        if (!d) { d = { name: to.department, positions: [] }; o.departments.push(d); }
        if (!(d.positions || (d.positions = [])).some((x) => posName(x) === to.position)) d.positions.push(to.position);
      }
      // курсы по должностям и санкнижки переезжают на новую должность
      const oldKey = keyOf(from.object, from.department, from.position);
      const newKey = keyOf(to.object, to.department, to.position);
      if (oldKey !== newKey) {
        await client.query(
          `DELETE FROM course_positions cp WHERE cp.key = $1
             AND EXISTS (SELECT 1 FROM course_positions x WHERE x.course_id = cp.course_id AND x.key = $2)`, [oldKey, newKey]);
        await client.query(`UPDATE course_positions SET object = $2, department = $3, position = $4, key = $5 WHERE key = $1`,
          [oldKey, to.object, to.department, to.position, newKey]);
        const hasNew = (await client.query('SELECT 1 FROM medbook_positions WHERE key = $1', [newKey])).rows.length;
        if (hasNew) await client.query('DELETE FROM medbook_positions WHERE key = $1', [oldKey]);
        else await client.query(`UPDATE medbook_positions SET object = $2, department = $3, position = $4, key = $5 WHERE key = $1`,
          [oldKey, to.object, to.department, to.position, newKey]);
      }
    }
    if (!dry && changes.length) {
      // Санкнижки: если у сотрудников новой должности уже внесены книжки, а должность ещё не отмечена
      // «санкнижка обязательна» — отмечаем сами (период — какой чаще у их книжек). Повторно грузить файл не нужно.
      const seenKeys = new Set();
      for (const c of changes) {
        const k = keyOf(c.to.object, c.to.department, c.to.position);
        if (seenKeys.has(k)) continue;
        seenKeys.add(k);
        const m = (await client.query(
          `SELECT mode() WITHIN GROUP (ORDER BY r.period_months) AS period
             FROM medbook_records r JOIN users u ON u.id = r.user_id
            WHERE u.role = 'employee' AND trim(COALESCE(u.object,'')) = $1 AND trim(COALESCE(u.department,'')) = $2 AND trim(COALESCE(u.position,'')) = $3`,
          [c.to.object, c.to.department, c.to.position])).rows[0];
        if (m && m.period) {
          await client.query(
            `INSERT INTO medbook_positions (object, department, position, key, period_months) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (key) DO NOTHING`,
            [c.to.object, c.to.department, c.to.position, k, Number(m.period)]);
        }
      }
      await client.query(
        `UPDATE medbook_records r SET manual = FALSE FROM users u, medbook_positions mp
          WHERE u.id = r.user_id AND r.manual = TRUE
            AND mp.key = lower(regexp_replace(trim(COALESCE(u.object,'')), '\\s+', ' ', 'g')) || '|' ||
                         lower(regexp_replace(trim(COALESCE(u.department,'')), '\\s+', ' ', 'g')) || '|' ||
                         lower(regexp_replace(trim(COALESCE(u.position,'')), '\\s+', ' ', 'g'))`);
      // старые должности без сотрудников убираем из структуры их отдела
      for (const c of changes) {
        const left = (await client.query(
          `SELECT 1 FROM users WHERE role = 'employee' AND trim(COALESCE(object,'')) = $1 AND trim(COALESCE(department,'')) = $2
              AND lower(trim(COALESCE(position,''))) = lower($3) LIMIT 1`, [c.from.object, c.from.department, c.from.position])).rows.length;
        if (left) continue;
        const o = dict.structure.find((x) => clean(x.object) === c.from.object);
        const d = o && (o.departments || []).find((x) => clean(x.name) === c.from.department);
        if (d) d.positions = (d.positions || []).filter((x) => posName(x).toLowerCase() !== c.from.position.toLowerCase()
          || (c.to.department === c.from.department && posName(x) === c.to.position));
      }
      dict.positions.sort((a, b) => posName(a).localeCompare(posName(b), 'ru'));
      const deps = [...new Set(dict.structure.flatMap((x) => (x.departments || []).map((d) => d.name)))].sort((a, b) => a.localeCompare(b, 'ru'));
      await client.query(
        `UPDATE settings SET positions_list = $1::jsonb, org_structure = $2::jsonb, objects_list = $3::jsonb, departments_list = $4::jsonb WHERE id = 1`,
        [JSON.stringify(dict.positions), JSON.stringify(dict.structure), JSON.stringify(dict.objects), JSON.stringify(deps)]
      );
    }
    if (dry) await client.query('ROLLBACK'); else await client.query('COMMIT');
    if (!dry) {
      await logAction(req, 'positions_remapped', {
        entityType: 'settings', entityName: String(req.file.originalname || ''),
        details: { rules: changes.length, employees: changes.reduce((s, c) => s + c.count, 0) }
      });
    }
    res.json({ dry_run: dry, changes, employees: changes.reduce((s, c) => s + c.count, 0), errors });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    res.status(500).json({ error: 'remap_failed', message: 'Не удалось выполнить замену: ' + e.message });
  } finally { client.release(); }
});

module.exports = router;
