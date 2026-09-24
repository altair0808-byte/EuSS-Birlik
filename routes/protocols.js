const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { authRequired, requireRole } = require('./auth');
const { buildProtocolDocx } = require('../protocolDocx');

// Протоколы комиссии по проверке знаний.
// Администратор «открывает» протокол — указывает его номер и диапазон дат
// (дата открытия / дата закрытия). Пока протокол открыт (status='open') и
// сегодняшняя дата попадает в его диапазон, каждому сотруднику, который
// СДАЁТ тест в эти дни, этот номер протокола присваивается автоматически
// (см. findActiveProtocol() ниже и его использование в routes/assignments.js
// в обработчике POST /:id/submit).
//
// Нумерация — своя для каждого года (год = год даты открытия протокола): новый протокол
// получает следующий номер после максимального в этом году (см. nextProtocolNumber),
// но номер можно ввести и вручную. Настроек нумерации протоколов в «Настройках» больше нет.
//
// Даты отдаём строкой YYYY-MM-DD (to_char), а не объектом Date — иначе при часовом поясе
// сервера, отличном от UTC, дата «съезжает» на день.
const PROTOCOL_COLS = `
  p.id, p.protocol_number, p.status, p.created_by, p.created_at,
  to_char(p.open_date, 'YYYY-MM-DD') AS open_date,
  to_char(p.close_date, 'YYYY-MM-DD') AS close_date
`;

// Кто входит в протокол: назначения, привязанные к нему при сдаче теста (protocol_id), а также
// внесённые вручную/импортом с тем же номером и датой протокола. Только сданные / несданные —
// «ожидающие» назначения в протокол не попадают.
const MEMBER_JOIN = `
  a.status IN ('passed', 'failed') AND (
    a.protocol_id = p.id
    OR (a.protocol_id IS NULL AND a.protocol_number = p.protocol_number
        AND LEFT(a.protocol_date, 10) = to_char(p.open_date, 'YYYY-MM-DD'))
  )
`;

// Следующий номер протокола в указанном году: максимальное число в номерах этого года + 1,
// с сохранением формата последнего номера («027» → «028», «9» → «10», «П-05» → «П-06»).
// В году без протоколов — «001».
async function nextProtocolNumber(year) {
  const y = parseInt(year, 10) || new Date().getFullYear();
  const result = await query(
    `SELECT protocol_number FROM protocols WHERE EXTRACT(YEAR FROM open_date)::int = $1`, [y]
  );
  let best = null;
  for (const row of result.rows) {
    const m = String(row.protocol_number).trim().match(/^(.*?)(\d+)$/);
    if (!m) continue;
    const n = parseInt(m[2], 10);
    if (!best || n > best.n) best = { prefix: m[1], digits: m[2].length, n };
  }
  if (!best) return '001';
  return best.prefix + String(best.n + 1).padStart(best.digits, '0');
}

// Есть ли уже протокол с таким номером в том же году (excludeId — при редактировании)
async function numberTaken(number, openDate, excludeId) {
  const result = await query(
    `SELECT id FROM protocols
     WHERE protocol_number = $1 AND EXTRACT(YEAR FROM open_date) = EXTRACT(YEAR FROM $2::date)
       AND ($3::bigint IS NULL OR id <> $3::bigint)
     LIMIT 1`,
    [number, openDate, excludeId || null]
  );
  return result.rows.length > 0;
}

// List all protocols (newest first)
router.get('/', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    // Единый фильтр по объекту/отделу: считаем только сотрудников выбранного объекта/отдела
    // и показываем только те протоколы, по которым такие сотрудники есть.
    const object = String(req.query.object || '').trim() || null;
    const department = String(req.query.department || '').trim() || null;
    const result = await query(`
      SELECT ${PROTOCOL_COLS}, (
        SELECT COUNT(DISTINCT a.user_id)::int FROM assignments a JOIN users u ON u.id = a.user_id
        WHERE u.role = 'employee' AND ${MEMBER_JOIN}
          AND ($1::text IS NULL OR u.object = $1) AND ($2::text IS NULL OR u.department = $2)
      ) AS assignments_count
      FROM protocols p
      ORDER BY p.open_date DESC, p.id DESC
    `, [object, department]);
    res.json((object || department) ? result.rows.filter(r => r.assignments_count > 0) : result.rows);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Протокол(ы), действующие сегодня — используется фронтендом, чтобы подсказать
// администратору при назначении теста, что номер протокола будет присвоен
// автоматически, когда сотрудник его сдаст.
router.get('/active', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const result = await query(`
      SELECT ${PROTOCOL_COLS} FROM protocols p
      WHERE p.status = 'open' AND CURRENT_DATE BETWEEN p.open_date AND p.close_date
      ORDER BY p.open_date DESC
    `);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Предлагаемый номер нового протокола для года: ?year=2026
router.get('/next-number', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    res.json({ year, next_number: await nextProtocolNumber(year) });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Скачать протокол в Word (.docx): дата открытия и номер подставляются в шапку,
// сотрудники протокола — в таблицу (ФИО кириллицей).
router.get('/:id/download', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const pRes = await query(`SELECT ${PROTOCOL_COLS} FROM protocols p WHERE p.id = $1`, [req.params.id]);
    const p = pRes.rows[0];
    if (!p) return res.status(404).json({ error: 'not_found', message: 'Протокол не найден' });

    // Порядок — по времени сдачи теста (как сотрудники проходили проверку), затем по ФИО
    const mRes = await query(`
      SELECT a.user_id, a.status, a.test_date,
             u.last_name, u.first_name, u.position, u.object, u.department,
             u.permanent_certificate_number, u.tco_badge
      FROM protocols p
      JOIN assignments a ON ${MEMBER_JOIN}
      JOIN users u ON u.id = a.user_id AND u.role = 'employee'
      WHERE p.id = $1
      ORDER BY a.test_date NULLS LAST, u.last_name, u.first_name, a.id
    `, [p.id]);

    const { buffer, fileName } = await buildProtocolDocx({
      protocolNumber: p.protocol_number,
      openDate: p.open_date,
      members: mRes.rows
    });

    const asciiName = `protocol_${p.open_date}_${String(p.protocol_number).replace(/[^A-Za-z0-9_-]/g, '')}.docx`;
    const encoded = encodeURIComponent(fileName).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encoded}`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(buffer);
  } catch (e) {
    console.error('Error building protocol docx:', e);
    res.status(500).json({ error: 'docx_error', message: 'Не удалось сформировать Word-файл: ' + e.message });
  }
});

// Открыть новый протокол
router.post('/', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  const { open_date, close_date } = req.body;
  let protocol_number = String(req.body.protocol_number ?? '').trim();
  if (!open_date || !close_date) {
    return res.status(400).json({ error: 'missing_fields', message: 'Укажите дату открытия и дату закрытия' });
  }
  if (new Date(close_date) < new Date(open_date)) {
    return res.status(400).json({ error: 'invalid_range', message: 'Дата закрытия не может быть раньше даты открытия' });
  }
  try {
    // Номер не введён вручную — берём следующий по нумерации года открытия
    if (!protocol_number) protocol_number = await nextProtocolNumber(String(open_date).slice(0, 4));
    if (await numberTaken(protocol_number, open_date)) {
      return res.status(409).json({ error: 'duplicate_number', message: `Протокол № ${protocol_number} за ${String(open_date).slice(0, 4)} год уже существует` });
    }
    const result = await query(`
      INSERT INTO protocols (protocol_number, open_date, close_date, status, created_by)
      VALUES ($1, $2, $3, 'open', $4)
      RETURNING id, protocol_number, status, created_by, created_at,
        to_char(open_date, 'YYYY-MM-DD') AS open_date, to_char(close_date, 'YYYY-MM-DD') AS close_date
    `, [protocol_number, open_date, close_date, req.user.id]);
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Изменить номер/даты протокола
router.patch('/:id', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  const { protocol_number, open_date, close_date, status } = req.body;
  const fields = [];
  const params = [];
  if (protocol_number !== undefined) { params.push(String(protocol_number).trim()); fields.push(`protocol_number = $${params.length}`); }
  if (open_date !== undefined) { params.push(open_date); fields.push(`open_date = $${params.length}`); }
  if (close_date !== undefined) { params.push(close_date); fields.push(`close_date = $${params.length}`); }
  if (status !== undefined) {
    if (!['open', 'closed'].includes(status)) return res.status(400).json({ error: 'invalid_status' });
    params.push(status); fields.push(`status = $${params.length}`);
  }
  if (!fields.length) return res.json({ ok: true });
  try {
    if (protocol_number !== undefined || open_date !== undefined) {
      const curRes = await query(`SELECT protocol_number, to_char(open_date, 'YYYY-MM-DD') AS open_date FROM protocols WHERE id = $1`, [req.params.id]);
      const cur = curRes.rows[0];
      if (!cur) return res.status(404).json({ error: 'not_found' });
      const newNumber = protocol_number !== undefined ? String(protocol_number).trim() : cur.protocol_number;
      const newOpen = open_date !== undefined ? open_date : cur.open_date;
      if (await numberTaken(newNumber, newOpen, req.params.id)) {
        return res.status(409).json({ error: 'duplicate_number', message: `Протокол № ${newNumber} за ${String(newOpen).slice(0, 4)} год уже существует` });
      }
    }
    params.push(req.params.id);
    const result = await query(`
      UPDATE protocols SET ${fields.join(', ')} WHERE id = $${params.length}
      RETURNING id, protocol_number, status, created_by, created_at,
        to_char(open_date, 'YYYY-MM-DD') AS open_date, to_char(close_date, 'YYYY-MM-DD') AS close_date
    `, params);
    if (!result.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Закрыть протокол вручную (до истечения даты закрытия)
router.post('/:id/close', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const result = await query(`UPDATE protocols SET status = 'closed' WHERE id = $1 RETURNING id, status`, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Снова открыть протокол
router.post('/:id/reopen', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const result = await query(`UPDATE protocols SET status = 'open' WHERE id = $1 RETURNING id, status`, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

router.delete('/:id', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    await query('DELETE FROM protocols WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Найти открытый протокол, диапазон дат которого покрывает указанную дату
// (YYYY-MM-DD). Используется при сдаче теста, чтобы автоматически присвоить
// номер протокола сотруднику, который сдал именно в эти дни.
async function findActiveProtocol(dateStr) {
  const result = await query(`
    SELECT ${PROTOCOL_COLS} FROM protocols p
    WHERE p.status = 'open' AND $1::date BETWEEN p.open_date AND p.close_date
    ORDER BY p.open_date DESC
    LIMIT 1
  `, [dateStr]);
  return result.rows[0] || null;
}

module.exports = router;
module.exports.findActiveProtocol = findActiveProtocol;
module.exports.nextProtocolNumber = nextProtocolNumber;
