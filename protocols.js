const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { authRequired, requireRole } = require('./auth');

// Протоколы комиссии по проверке знаний (п.1 и п.4 запроса).
// Администратор "открывает" протокол — указывает его номер и диапазон дат
// (дата открытия / дата закрытия). Пока протокол открыт (status='open') и
// сегодняшняя дата попадает в его диапазон, каждому сотруднику, который
// СДАЁТ тест в эти дни, этот номер протокола присваивается автоматически
// (см. findActiveProtocol() ниже и его использование в routes/assignments.js
// в обработчике POST /:id/submit).

// List all protocols (newest first)
router.get('/', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const result = await query(`
      SELECT p.*, (SELECT COUNT(*)::int FROM assignments a WHERE a.protocol_id = p.id) AS assignments_count
      FROM protocols p
      ORDER BY p.open_date DESC, p.id DESC
    `);
    res.json(result.rows);
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
      SELECT * FROM protocols
      WHERE status = 'open' AND CURRENT_DATE BETWEEN open_date AND close_date
      ORDER BY open_date DESC
    `);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Открыть новый протокол
router.post('/', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  const { protocol_number, open_date, close_date } = req.body;
  if (!protocol_number || !open_date || !close_date) {
    return res.status(400).json({ error: 'missing_fields', message: 'Укажите номер протокола, дату открытия и дату закрытия' });
  }
  if (new Date(close_date) < new Date(open_date)) {
    return res.status(400).json({ error: 'invalid_range', message: 'Дата закрытия не может быть раньше даты открытия' });
  }
  try {
    const result = await query(`
      INSERT INTO protocols (protocol_number, open_date, close_date, status, created_by)
      VALUES ($1, $2, $3, 'open', $4) RETURNING *
    `, [String(protocol_number).trim(), open_date, close_date, req.user.id]);
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Изменить номер/даты протокола (п.4 — редактирование даты открытия и закрытия)
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
    params.push(req.params.id);
    const result = await query(`UPDATE protocols SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    if (!result.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Закрыть протокол вручную (до истечения даты закрытия)
router.post('/:id/close', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const result = await query(`UPDATE protocols SET status = 'closed' WHERE id = $1 RETURNING *`, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Снова открыть протокол
router.post('/:id/reopen', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const result = await query(`UPDATE protocols SET status = 'open' WHERE id = $1 RETURNING *`, [req.params.id]);
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
    SELECT * FROM protocols
    WHERE status = 'open' AND $1::date BETWEEN open_date AND close_date
    ORDER BY open_date DESC
    LIMIT 1
  `, [dateStr]);
  return result.rows[0] || null;
}

module.exports = router;
module.exports.findActiveProtocol = findActiveProtocol;
