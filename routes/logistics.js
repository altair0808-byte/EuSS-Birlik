// Логистика: заявки на автобус (пересменка) и на проживание (общежитие).
// Права (выдаёт суперадмин в карточке админа/ассистента, раздел «Логистика»):
//   transport          — записывать сотрудников на автобус
//   transport_dispatch — принимать заявку: № автобуса, время, статус «Принято»
//   housing            — заявки на проживание
// Списки «кто заезжает / выезжает в дату» берутся из графика вахты (users.rotation_*).
const express = require('express');
const ExcelJS = require('exceljs');
const { query } = require('../db');
const { authRequired } = require('./auth');
const { hasLogiFunction, requireLogi } = require('../lib/adminFunctions');
const { scopedFilter } = require('../lib/multiFilter');
const { ROT_SQL } = require('./users');

const router = express.Router();
const REST = ROT_SQL.ROT_REST_SQL;
const CYCLE = ROT_SQL.ROT_CYCLE_SQL;

const isoDate = (v) => {
  const s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
// Пол по отчеству/фамилии, если в карточке не указан (-вна/-қызы → Female, -вич/-ұлы → Male, -ова/-ева → Female)
function guessGender(last, first) {
  const s = `${first || ''} ${last || ''}`.toLowerCase();
  const l = String(last || '').toLowerCase().trim();
  if (/(вна|кызы|қызы|qyzy|kyzy)(\s|$)/.test(s) || /(ова|ева|ина|ская|цкая)$/.test(l)) return 'female';
  if (/(вич|улы|ұлы|uly|ogly|оглы)(\s|$)/.test(s) || /(ов|ев|ин|ский|цкий)$/.test(l)) return 'male';
  return '';
}
const clean = (v, n = 300) => String(v == null ? '' : v).trim().slice(0, n);
function perms(user) {
  return {
    transport: hasLogiFunction(user, 'transport'),
    dispatch: hasLogiFunction(user, 'transport_dispatch'),
    housing: hasLogiFunction(user, 'housing'),
    superadmin: !!user && user.role === 'superadmin'
  };
}
// Зона ассистента (руководитель отдела видит только своих): SQL-условие для alias u
function zoneSql(user, params, alias = 'u') {
  const sc = scopedFilter(user, [], []);
  if (sc.noAccess) {
    // ассистент без зоны — логист на весь объект: видит всех (доступ ограничен самой функцией)
    return '';
  }
  let sql = '';
  if (sc.objects.length) { params.push(sc.objects); sql += ` AND ${alias}.object = ANY($${params.length}::text[])`; }
  if (sc.departments.length) { params.push(sc.departments); sql += ` AND ${alias}.department = ANY($${params.length}::text[])`; }
  return sql;
}
async function loadSettings() {
  const [s, r, cc, rt] = await Promise.all([
    query('SELECT * FROM logi_settings WHERE id = 1'),
    query('SELECT point, in_time, out_time, sort FROM logi_routes ORDER BY sort, point'),
    query('SELECT department, cost_center FROM logi_cost_centers ORDER BY department'),
    query('SELECT position, room_type FROM logi_room_types ORDER BY position')
  ]);
  return { settings: s.rows[0] || {}, routes: r.rows, cost_centers: cc.rows, room_types: rt.rows };
}

// ───────────────────────── общее ─────────────────────────
router.get('/me', authRequired, async (req, res) => {
  const p = perms(req.user);
  if (!p.transport && !p.dispatch && !p.housing) return res.json({ perms: p });
  try { res.json({ perms: p, ...(await loadSettings()) }); }
  catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

// Настройки (направления, центр затрат по отделу, тип комнаты по должности) — только суперадмин
router.get('/catalog', authRequired, async (req, res) => {
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'forbidden' });
  try {
    const d = await query(`SELECT DISTINCT department FROM users WHERE role = 'employee' AND COALESCE(department,'') <> '' ORDER BY department`);
    const p = await query(`SELECT DISTINCT position FROM users WHERE role = 'employee' AND COALESCE(position,'') <> '' ORDER BY position`);
    res.json({ departments: d.rows.map((x) => x.department), positions: p.rows.map((x) => x.position), ...(await loadSettings()) });
  } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});
router.put('/settings', authRequired, async (req, res) => {
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'forbidden' });
  const b = req.body || {};
  try {
    if (b.settings) {
      const s = b.settings;
      await query(`UPDATE logi_settings SET travel_cause = $1, company = $2, direct_tco = $3, request_department = $4, request_cc = $5, request_email = $6 WHERE id = 1`,
        [clean(s.travel_cause) || 'Crew change', clean(s.company) || 'EUSS', clean(s.direct_tco) || 'Yes', clean(s.request_department), clean(s.request_cc), clean(s.request_email)]);
    }
    if (Array.isArray(b.routes)) {
      const pts = b.routes.map((r, i) => ({ point: clean(r.point, 80), in_time: clean(r.in_time, 10) || '06:00', out_time: clean(r.out_time, 10) || '12:00', sort: i + 1 })).filter((r) => r.point);
      await query('DELETE FROM logi_routes WHERE NOT (point = ANY($1::text[]))', [pts.map((r) => r.point)]);
      for (const r of pts) {
        await query(`INSERT INTO logi_routes (point, in_time, out_time, sort) VALUES ($1,$2,$3,$4)
                     ON CONFLICT (point) DO UPDATE SET in_time = EXCLUDED.in_time, out_time = EXCLUDED.out_time, sort = EXCLUDED.sort`, [r.point, r.in_time, r.out_time, r.sort]);
      }
    }
    if (Array.isArray(b.cost_centers)) {
      await query('DELETE FROM logi_cost_centers');
      for (const r of b.cost_centers) {
        const d = clean(r.department, 200), c = clean(r.cost_center, 200);
        if (d && c) await query('INSERT INTO logi_cost_centers (department, cost_center) VALUES ($1,$2) ON CONFLICT (department) DO UPDATE SET cost_center = EXCLUDED.cost_center', [d, c]);
      }
    }
    if (Array.isArray(b.room_types)) {
      await query('DELETE FROM logi_room_types');
      for (const r of b.room_types) {
        const p = clean(r.position, 200), t = r.room_type === 'single' ? 'single' : r.room_type === 'double' ? 'double' : '';
        if (p && t) await query('INSERT INTO logi_room_types (position, room_type) VALUES ($1,$2) ON CONFLICT (position) DO UPDATE SET room_type = EXCLUDED.room_type', [p, t]);
      }
    }
    res.json({ ok: true, ...(await loadSettings()) });
  } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

// Кто заезжает / выезжает в дату — по графику вахты.
// Заезд: дата = заезд + k·цикл; выезд: дата = отъезд + k·цикл (пересменка в 12:00). Цикл = (отъезд − заезд) + дома.
// Кто в овертайме (с ≤ дата < по) — не выезжает; конец овертайма (по = дата) — выезжает.
router.get('/rotation', authRequired, requireLogi('transport', 'transport_dispatch', 'housing'), async (req, res) => {
  const date = isoDate(req.query.date);
  if (!date) return res.status(400).json({ error: 'bad_date', message: 'Укажите дату' });
  try {
    const params = [date];
    const zone = zoneSql(req.user, params, 'u');
    const arrSql = `(u.rotation_arrival IS NOT NULL AND ($1::date = u.rotation_arrival OR (u.rotation_departure IS NOT NULL AND ${REST} > 0 AND ${CYCLE} > 0
                      AND $1::date > u.rotation_arrival AND ($1::date - u.rotation_arrival) % ${CYCLE} = 0)))`;
    const depSql = `(u.rotation_departure IS NOT NULL AND ($1::date = u.rotation_departure OR (u.rotation_arrival IS NOT NULL AND ${REST} > 0 AND ${CYCLE} > 0
                      AND $1::date > u.rotation_departure AND ($1::date - u.rotation_departure) % ${CYCLE} = 0)))`;
    const otHold = `(u.overtime_from IS NOT NULL AND u.overtime_to IS NOT NULL AND u.overtime_from <= $1::date AND u.overtime_to > $1::date)`;
    const otEnd = `(u.overtime_to IS NOT NULL AND u.overtime_to = $1::date)`;
    const r = await query(`
      SELECT u.id, u.last_name, u.first_name, u.department, u.position, u.object, u.tco_badge, u.home_point, u.gender, u.nationality, u.phone,
             CASE WHEN ${arrSql} THEN 1 ELSE 0 END AS arriving,
             CASE WHEN (${depSql} AND NOT ${otHold}) OR ${otEnd} THEN 1 ELSE 0 END AS departing,
             CASE WHEN ${otEnd} THEN 1 ELSE 0 END AS overtime_end,
             CASE WHEN u.rotation_arrival IS NOT NULL AND u.rotation_departure IS NOT NULL
                  THEN to_char($1::date + (u.rotation_departure - u.rotation_arrival), 'YYYY-MM-DD') END AS shift_end,
             (SELECT string_agg(tp.direction, ',') FROM transport_passengers tp JOIN transport_requests tr ON tr.id = tp.request_id
               WHERE tr.travel_date = $1::date AND tp.user_id = u.id) AS in_transport,
             EXISTS (SELECT 1 FROM housing_requests h WHERE h.user_id = u.id AND h.check_in = $1::date) AS in_housing
      FROM users u
      WHERE u.role = 'employee' AND u.active = 1 AND COALESCE(u.employment_status, 'active') = 'active'
        AND (${arrSql} OR (${depSql} AND NOT ${otHold}) OR ${otEnd}) ${zone}
      ORDER BY u.department, u.last_name, u.first_name`, params);
    const rows = r.rows.map((x) => ({ ...x, arriving: !!x.arriving, departing: !!x.departing, overtime_end: !!x.overtime_end,
      in_transport: x.in_transport ? x.in_transport.split(',') : [] }));
    res.json({ date, arriving: rows.filter((x) => x.arriving), departing: rows.filter((x) => x.departing) });
  } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

// Поиск сотрудника вручную (кто не по графику: после больничного, новый и т.д.)
router.get('/search', authRequired, requireLogi('transport', 'transport_dispatch', 'housing'), async (req, res) => {
  const q = clean(req.query.q, 80);
  if (q.length < 2) return res.json([]);
  try {
    const { fuzzyHas } = require('../lib/fuzzy');
    const params = [];
    const zone = zoneSql(req.user, params, 'u');
    const r = await query(`SELECT u.id, u.last_name, u.first_name, u.department, u.position, u.tco_badge, u.home_point, u.login, u.full_name_translit
      FROM users u WHERE u.role = 'employee' AND u.active = 1 AND COALESCE(u.employment_status,'active') = 'active' ${zone}`, params);
    const out = r.rows.filter((u) => fuzzyHas(`${u.last_name} ${u.first_name} | ${u.first_name} ${u.last_name} | ${u.login || ''} | ${u.tco_badge || ''} | ${u.full_name_translit || ''}`, q)).slice(0, 30);
    res.json(out.map(({ login, full_name_translit, ...u }) => u));
  } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

// ───────────────────────── автобус ─────────────────────────
async function loadTransport(date) {
  const reqRes = await query(`SELECT r.*, to_char(r.travel_date, 'YYYY-MM-DD') AS travel_date,
      (SELECT last_name || ' ' || first_name FROM users WHERE id = r.created_by) AS created_by_name,
      (SELECT last_name || ' ' || first_name FROM users WHERE id = r.accepted_by) AS accepted_by_name
    FROM transport_requests r WHERE r.travel_date = $1::date`, [date]);
  const rq = reqRes.rows[0] || null;
  if (!rq) return { request: null, passengers: [], buses: [] };
  const p = await query(`SELECT tp.id, tp.user_id, tp.direction, tp.point, tp.note, tp.added_by,
      u.last_name, u.first_name, u.department, u.position, u.tco_badge, u.object,
      (SELECT last_name || ' ' || first_name FROM users WHERE id = tp.added_by) AS added_by_name
    FROM transport_passengers tp JOIN users u ON u.id = tp.user_id
    WHERE tp.request_id = $1 ORDER BY tp.direction, tp.point, u.last_name, u.first_name`, [rq.id]);
  const b = await query('SELECT direction, point, bus_number, dep_time, note FROM transport_buses WHERE request_id = $1', [rq.id]);
  return { request: rq, passengers: p.rows, buses: b.rows };
}

router.get('/transport', authRequired, requireLogi('transport', 'transport_dispatch'), async (req, res) => {
  const date = isoDate(req.query.date);
  if (!date) return res.status(400).json({ error: 'bad_date' });
  try { res.json(await loadTransport(date)); }
  catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

// Список заявок (ближайшие и недавние даты)
router.get('/transport/list', authRequired, requireLogi('transport', 'transport_dispatch'), async (req, res) => {
  try {
    const r = await query(`SELECT r.id, to_char(r.travel_date, 'YYYY-MM-DD') AS travel_date, r.status,
        COUNT(*) FILTER (WHERE tp.direction = 'in')::int AS cnt_in, COUNT(*) FILTER (WHERE tp.direction = 'out')::int AS cnt_out
      FROM transport_requests r LEFT JOIN transport_passengers tp ON tp.request_id = r.id
      WHERE r.travel_date >= (NOW() AT TIME ZONE 'Asia/Atyrau')::date - 30
      GROUP BY r.id ORDER BY r.travel_date DESC LIMIT 60`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

router.post('/transport/passengers', authRequired, requireLogi('transport', 'transport_dispatch'), async (req, res) => {
  const date = isoDate(req.body && req.body.date);
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  if (!date || !items.length) return res.status(400).json({ error: 'bad_request', message: 'Нет даты или сотрудников' });
  try {
    let rq = (await query('SELECT * FROM transport_requests WHERE travel_date = $1::date', [date])).rows[0];
    if (!rq) rq = (await query(`INSERT INTO transport_requests (travel_date, created_by) VALUES ($1::date, $2)
                                ON CONFLICT (travel_date) DO UPDATE SET travel_date = EXCLUDED.travel_date RETURNING *`, [date, req.user.id])).rows[0];
    let added = 0;
    for (const it of items) {
      const uid = Number(it.user_id), dir = it.direction === 'out' ? 'out' : 'in', point = clean(it.point, 80);
      if (!uid || !point) continue;
      const r = await query(`INSERT INTO transport_passengers (request_id, user_id, direction, point, note, added_by) VALUES ($1,$2,$3,$4,$5,$6)
                             ON CONFLICT (request_id, user_id, direction) DO UPDATE SET point = EXCLUDED.point, note = EXCLUDED.note RETURNING id`,
        [rq.id, uid, dir, point, clean(it.note, 200), req.user.id]);
      if (r.rows[0]) added++;
      await query('UPDATE users SET home_point = $2 WHERE id = $1', [uid, point]);   // запомним направление на следующий раз
    }
    // заявку уже приняли, а люди добавились — снова «на приёме»
    if (rq.status === 'accepted') await query(`UPDATE transport_requests SET status = 'submitted' WHERE id = $1`, [rq.id]);
    res.json({ ok: true, added, ...(await loadTransport(date)) });
  } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

router.patch('/transport/passengers/:id', authRequired, requireLogi('transport', 'transport_dispatch'), async (req, res) => {
  try {
    const b = req.body || {};
    const p = (await query('SELECT tp.*, r.travel_date FROM transport_passengers tp JOIN transport_requests r ON r.id = tp.request_id WHERE tp.id = $1', [req.params.id])).rows[0];
    if (!p) return res.status(404).json({ error: 'not_found' });
    const point = b.point !== undefined ? clean(b.point, 80) : p.point;
    const note = b.note !== undefined ? clean(b.note, 200) : p.note;
    await query('UPDATE transport_passengers SET point = $2, note = $3 WHERE id = $1', [p.id, point || p.point, note]);
    if (b.point) await query('UPDATE users SET home_point = $2 WHERE id = $1', [p.user_id, point]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

router.delete('/transport/passengers/:id', authRequired, requireLogi('transport', 'transport_dispatch'), async (req, res) => {
  try {
    const p = (await query('SELECT id, added_by FROM transport_passengers WHERE id = $1', [req.params.id])).rows[0];
    if (!p) return res.json({ ok: true });
    const pm = perms(req.user);
    if (!pm.dispatch && !pm.superadmin && String(p.added_by) !== String(req.user.id) && req.user.role === 'assistant') {
      // руководитель отдела убирает своих (в зоне) — проверим зону
      const params = [p.id];
      const zone = zoneSql(req.user, params, 'u');
      const ok = await query(`SELECT 1 FROM transport_passengers tp JOIN users u ON u.id = tp.user_id WHERE tp.id = $1 ${zone}`, params);
      if (!ok.rows[0]) return res.status(403).json({ error: 'forbidden', message: 'Можно убрать только своих сотрудников' });
    }
    await query('DELETE FROM transport_passengers WHERE id = $1', [p.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

router.post('/transport/:id/submit', authRequired, requireLogi('transport', 'transport_dispatch'), async (req, res) => {
  try {
    await query(`UPDATE transport_requests SET status = CASE WHEN status = 'accepted' THEN status ELSE 'submitted' END,
                 submitted_by = $2, submitted_at = NOW() WHERE id = $1`, [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

// Принимающий: автобусы по группам (направление + пункт) и, при accept = true, статус «Принято»
router.post('/transport/:id/buses', authRequired, requireLogi('transport_dispatch'), async (req, res) => {
  try {
    const buses = Array.isArray(req.body && req.body.buses) ? req.body.buses : [];
    for (const b of buses) {
      const dir = b.direction === 'out' ? 'out' : 'in', point = clean(b.point, 80);
      if (!point) continue;
      await query(`INSERT INTO transport_buses (request_id, direction, point, bus_number, dep_time, note) VALUES ($1,$2,$3,$4,$5,$6)
                   ON CONFLICT (request_id, direction, point) DO UPDATE SET bus_number = EXCLUDED.bus_number, dep_time = EXCLUDED.dep_time, note = EXCLUDED.note`,
        [req.params.id, dir, point, clean(b.bus_number, 60), clean(b.dep_time, 10), clean(b.note, 200)]);
    }
    if (req.body && req.body.accept) {
      await query(`UPDATE transport_requests SET status = 'accepted', accepted_by = $2, accepted_at = NOW() WHERE id = $1`, [req.params.id, req.user.id]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

// Excel в виде формы «Заявка на предоставление транспорта»: слева X → Birlik, справа Birlik → X
router.get('/transport/:id/export.xlsx', authRequired, requireLogi('transport', 'transport_dispatch'), async (req, res) => {
  try {
    const rq = (await query(`SELECT *, to_char(travel_date, 'YYYY-MM-DD') AS d FROM transport_requests WHERE id = $1`, [req.params.id])).rows[0];
    if (!rq) return res.status(404).json({ error: 'not_found' });
    const data = await loadTransport(rq.d);
    const st = await loadSettings();
    const S = st.settings;
    const initiator = (await query('SELECT last_name, first_name, phone, email FROM users WHERE id = $1', [rq.submitted_by || rq.created_by || req.user.id])).rows[0] || {};
    const routeOf = (p) => st.routes.find((r) => r.point === p) || { point: p, in_time: '', out_time: '12:00' };
    const busOf = (dir, p) => data.buses.find((b) => b.direction === dir && b.point === p) || {};
    const groups = (dir) => {
      const pts = [...new Set([...st.routes.map((r) => r.point), ...data.passengers.filter((x) => x.direction === dir).map((x) => x.point)])];
      return pts.map((p) => ({ point: p, list: data.passengers.filter((x) => x.direction === dir && x.point === p) })).filter((g) => g.list.length);
    };

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Table');
    ws.columns = [{ width: 4.7 }, { width: 46.6 }, { width: 22 }, { width: 1.3 }, { width: 4.4 }, { width: 37.1 }, { width: 22 }];
    const thin = { style: 'thin' };
    const box = { top: thin, left: thin, bottom: thin, right: thin };
    const grey = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
    const set = (addr, v, o = {}) => {
      const c = ws.getCell(addr);
      c.value = v;
      c.font = { name: 'Calibri', size: 11, bold: !!o.bold };
      c.alignment = { vertical: 'middle', wrapText: true, horizontal: o.center ? 'center' : 'left' };
      if (o.fill) c.fill = grey;
      if (o.border !== false) c.border = box;
      if (o.fmt) c.numFmt = o.fmt;
      return c;
    };
    const dt = (iso) => { const [y, m, d] = String(iso).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };

    ws.mergeCells('A2:D2'); ws.mergeCells('E2:G2');
    set('A2', 'Инициатор должен направить Заявку на предоставление транспорта не позднее, чем за 48 часа до планируемого времени отправления транспортного средства на адрес - crewchangecoor@esskaz.com', { border: false });
    set('E2', 'Initiator shoud email a transportation request 48 hours prior to the scheduled departure of vehicle to - crewchangecoor@esskaz.com', { border: false });
    ws.getRow(2).height = 49;
    const head = [
      ['Дата подачи заявки / Request Date', dt(new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10)), 'Дата отправления / Departure Date', dt(rq.d)],
      ['ФИО инициатора / Initiator Name ', `${initiator.last_name || ''} ${initiator.first_name || ''}`.trim(), 'Тел# инициатора / Initiator Tel#', initiator.phone || ''],
      ['Департамент / Department', S.request_department || '', 'ЦЗ / CC', S.request_cc || ''],
      ['Цель поездки / Travel Cause', S.travel_cause || 'Crew change', 'Эл-почта инициатора / Initiator e-mail', S.request_email || initiator.email || '']
    ];
    head.forEach((h, i) => {
      const r = 3 + i;
      ws.mergeCells(`A${r}:B${r}`); ws.mergeCells(`C${r}:D${r}`); ws.mergeCells(`E${r}:F${r}`);
      set(`A${r}`, h[0], { bold: true, fill: true });
      set(`C${r}`, h[1], { fmt: h[1] instanceof Date ? 'dd.mm.yyyy' : undefined });
      set(`E${r}`, h[2], { bold: true, fill: true });
      set(`G${r}`, h[3], { fmt: h[3] instanceof Date ? 'dd.mm.yyyy' : undefined });
    });

    // блоки маршрутов: колонка A..C (in) и E..G (out), идут вниз независимо
    const drawSide = (dir, startRow) => {
      const L = dir === 'in' ? ['A', 'B', 'C'] : ['E', 'F', 'G'];
      let r = startRow;
      for (const g of groups(dir)) {
        const rt = routeOf(g.point), bus = busOf(dir, g.point);
        const title = dir === 'in' ? `${g.point} - Birlik` : `Birlik - ${g.point}`;
        ws.mergeCells(`${L[0]}${r}:${L[1]}${r}`);
        set(`${L[0]}${r}`, 'Маршрут следования / Route', { bold: true, fill: true });
        set(`${L[2]}${r}`, title + (bus.bus_number ? `  ·  Bus № ${bus.bus_number}` : ''), { bold: true });
        r++;
        ws.mergeCells(`${L[0]}${r}:${L[1]}${r}`);
        set(`${L[0]}${r}`, 'Время отправления / Departure Time', { bold: true, fill: true });
        set(`${L[2]}${r}`, bus.dep_time || (dir === 'in' ? rt.in_time : rt.out_time) || '', { bold: true });
        r++;
        set(`${L[0]}${r}`, ' #', { bold: true, fill: true, center: true });
        set(`${L[1]}${r}`, 'ФИО пассажира / Passenger’s Name ', { bold: true, fill: true });
        set(`${L[2]}${r}`, '#Пропуск / #Badge', { bold: true, fill: true });
        r++;
        g.list.forEach((p, i) => {
          set(`${L[0]}${r}`, i + 1, { center: true });
          set(`${L[1]}${r}`, `${p.last_name} ${p.first_name}`.trim());
          const badge = String(p.tco_badge || '').trim();
          set(`${L[2]}${r}`, badge ? (/^\d+$/.test(badge) ? Number(badge) : badge) : 'new', { center: false });
          r++;
        });
      }
      return r;
    };
    const endIn = drawSide('in', 8);
    const endOut = drawSide('out', 8);
    if (endIn === 8 && endOut === 8) { set('A8', 'Нет пассажиров', { border: false }); }
    Object.assign(ws.pageSetup, { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 });

    const [y, m, d] = rq.d.split('-');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${d}-${m}-${y}.xlsx"`);
    res.setHeader('Cache-Control', 'no-store');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('transport export:', e);
    if (!res.headersSent) res.status(500).json({ error: 'export_error', details: e.message });
  }
});

// ───────────────────────── проживание ─────────────────────────
const HOUSING_SELECT = `SELECT h.id, h.user_id, to_char(h.check_in, 'YYYY-MM-DD') AS check_in, to_char(h.check_out, 'YYYY-MM-DD') AS check_out,
    h.room_type, h.cost_center, h.gender, h.nationality, h.b2b, h.comment, h.birlik_comment, h.room_number, h.alcohol_test, h.contact,
    h.status, h.created_by, u.last_name, u.first_name, u.department, u.position, u.tco_badge, u.object,
    (SELECT last_name || ' ' || first_name FROM users WHERE id = h.created_by) AS created_by_name
  FROM housing_requests h JOIN users u ON u.id = h.user_id`;

router.get('/housing', authRequired, requireLogi('housing'), async (req, res) => {
  try {
    const from = isoDate(req.query.from), to = isoDate(req.query.to);
    const params = [];
    let where = 'WHERE TRUE';
    if (from) { params.push(from); where += ` AND h.check_in >= $${params.length}::date`; }
    if (to) { params.push(to); where += ` AND h.check_in <= $${params.length}::date`; }
    where += zoneSql(req.user, params, 'u');
    const r = await query(`${HOUSING_SELECT} ${where} ORDER BY h.check_in DESC, u.last_name LIMIT 1000`, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

router.post('/housing', authRequired, requireLogi('housing'), async (req, res) => {
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'bad_request', message: 'Нет сотрудников' });
  try {
    const st = await loadSettings();
    const ccOf = (d) => (st.cost_centers.find((x) => x.department === d) || {}).cost_center || '';
    const rtOf = (p) => (st.room_types.find((x) => x.position === p) || {}).room_type || 'double';
    let added = 0; const skipped = [];
    for (const it of items) {
      const uid = Number(it.user_id), ci = isoDate(it.check_in), co = isoDate(it.check_out);
      if (!uid || !ci) continue;
      const u = (await query('SELECT id, last_name, first_name, department, position, gender, nationality, phone FROM users WHERE id = $1', [uid])).rows[0];
      if (!u) continue;
      const r = await query(`INSERT INTO housing_requests (user_id, check_in, check_out, room_type, cost_center, gender, nationality, b2b, comment, contact, created_by)
                             VALUES ($1,$2::date,$3::date,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (user_id, check_in) DO NOTHING RETURNING id`,
        [uid, ci, co, it.room_type === 'single' || it.room_type === 'double' ? it.room_type : rtOf(u.position), clean(it.cost_center) || ccOf(u.department),
         (u.gender || guessGender(u.last_name, u.first_name)) === 'female' ? 'Female' : (u.gender || guessGender(u.last_name, u.first_name)) === 'male' ? 'Male' : '', u.nationality || 'Kazakhstan', clean(it.b2b, 120), clean(it.comment, 300), u.phone || '', req.user.id]);
      if (r.rows[0]) added++; else skipped.push(`${u.last_name} ${u.first_name}`);
    }
    res.json({ ok: true, added, skipped });
  } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

router.patch('/housing/:id', authRequired, requireLogi('housing'), async (req, res) => {
  try {
    const b = req.body || {};
    const cols = { check_in: 'date', check_out: 'date', room_type: 'room', cost_center: 't', gender: 't', nationality: 't', b2b: 't', comment: 't',
      birlik_comment: 't', room_number: 't', alcohol_test: 't', contact: 't', status: 'status' };
    const sets = []; const params = [req.params.id];
    for (const [k, kind] of Object.entries(cols)) {
      if (b[k] === undefined) continue;
      let v = b[k];
      if (kind === 'date') { v = isoDate(v); if (!v && k === 'check_in') continue; }
      else if (kind === 'room') v = v === 'single' ? 'single' : 'double';
      else if (kind === 'status') { if (!['new', 'sent', 'accepted'].includes(v)) continue; }
      else v = clean(v, 300);
      params.push(v); sets.push(`${k} = $${params.length}${kind === 'date' ? '::date' : ''}`);
    }
    if (!sets.length) return res.json({ ok: true });
    await query(`UPDATE housing_requests SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, params);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

router.delete('/housing/:id', authRequired, requireLogi('housing'), async (req, res) => {
  try { await query('DELETE FROM housing_requests WHERE id = $1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

// Excel в виде формы «Accommodation form» — выбранные строки (ids) или все за период; помечает «отправлено»
router.post('/housing/export.xlsx', authRequired, requireLogi('housing'), async (req, res) => {
  try {
    const ids = ((req.body && req.body.ids) || []).map(Number).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'bad_request', message: 'Выберите строки' });
    const r = await query(`${HOUSING_SELECT} WHERE h.id = ANY($1::bigint[]) ORDER BY h.check_in, u.last_name`, [ids]);
    const S = (await loadSettings()).settings;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Accommodation form');
    const widths = [12.6, 10.6, 13.3, 24.6, 19, 30.6, 18.3, 16.9, 9, 24.1, 17.1, 19.3, 23, 42.3, 10, 14.3, 30];
    ws.columns = widths.map((w) => ({ width: w }));
    ws.mergeCells('A1:M1'); ws.mergeCells('A2:M2');
    ws.getCell('A1').value = 'Заявка на предоставление Услуг по проживанию, питанию и медицинскому освидетельствованию';
    ws.getCell('A2').value = 'Reservation Request for accommodation, catering services and medical assessments';
    ['A1', 'A2'].forEach((a) => { ws.getCell(a).font = { name: 'Calibri', size: 14, bold: true }; ws.getCell(a).alignment = { horizontal: 'center' }; });
    const heads = ['Компания/Company name ', 'Центр затрат/Cost centr', 'Прямой подрядчик TCO или нет/ Direct TCO contractor or not', 'Имя Фамилия/Name, Surname ',
      'Номер пропуска/ Badge number ', 'Должность/Position ', 'Запрашиваемый тип комнаты/Requested room type    ', 'Пол/Gender', 'Номер комнаты/Room number',
      'Дата/время заезда/Check-in date & time', 'Дата/время выезда/Check-out date & time', 'Сменщик/B2b', 'Гражданство/Nationality', 'Комментарии/Comments',
      'Комментарии от Бирлик/Comments from Birlik', 'Алкотест/ Alcohol test', 'Контактные данные/Contact details'];
    const thin = { style: 'thin' };
    const box = { top: thin, left: thin, bottom: thin, right: thin };
    const hr = ws.getRow(3);
    heads.forEach((h, i) => {
      const c = hr.getCell(i + 1);
      c.value = h; c.font = { name: 'Calibri', size: 11, bold: true };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
      c.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' }; c.border = box;
    });
    hr.height = 100;
    const dt = (iso) => { if (!iso) return null; const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
    r.rows.forEach((h, i) => {
      const row = ws.getRow(4 + i);
      const badge = String(h.tco_badge || '').trim();
      const cc = String(h.cost_center || '').trim();
      const vals = [S.company || 'EUSS', /^\d+$/.test(cc) ? Number(cc) : cc, S.direct_tco || 'Yes', `${h.last_name} ${h.first_name}`.trim(),
        badge ? (/^\d+$/.test(badge) ? Number(badge) : badge) : 'new', h.position || '', h.room_type || 'double', h.gender || '', h.room_number || '',
        dt(h.check_in), dt(h.check_out), h.b2b || '', h.nationality || 'Kazakhstan', h.comment || '', h.birlik_comment || '', h.alcohol_test || '', h.contact || ''];
      vals.forEach((v, j) => {
        const c = row.getCell(j + 1);
        c.value = v; c.border = box; c.font = { name: 'Calibri', size: 11 };
        c.alignment = { vertical: 'middle', wrapText: true };
        if (v instanceof Date) c.numFmt = 'dd.mm.yyyy';
      });
    });
    await query(`UPDATE housing_requests SET status = 'sent', updated_at = NOW() WHERE id = ANY($1::bigint[]) AND status = 'new'`, [ids]);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Accommodation-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.setHeader('Cache-Control', 'no-store');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('housing export:', e);
    if (!res.headersSent) res.status(500).json({ error: 'export_error', details: e.message });
  }
});

module.exports = router;
