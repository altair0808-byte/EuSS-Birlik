// Колокольчик в шапке для администраторов/ассистентов: результаты тестов сотрудников, которых они записали.
const express = require('express');
const { query } = require('../db');
const { authRequired, requireRole } = require('./auth');

const router = express.Router();
const STAFF = requireRole('admin', 'superadmin', 'assistant');

// GET /api/staff-notifications — последние 50 + количество непрочитанных
router.get('/', authRequired, STAFF, async (req, res) => {
  try {
    const [list, cnt] = await Promise.all([
      query(`SELECT id, kind, assignment_id, employee_id, employee_name, course_title, score, created_at, read_at
             FROM staff_notifications WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50`, [req.user.id]),
      query(`SELECT COUNT(*)::int AS n FROM staff_notifications WHERE user_id = $1 AND read_at IS NULL`, [req.user.id])
    ]);
    res.json({ unread: cnt.rows[0].n, items: list.rows });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// POST /api/staff-notifications/read  { ids?: number[] } — без ids отмечает прочитанными все
router.post('/read', authRequired, STAFF, async (req, res) => {
  try {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : null;
    if (ids && ids.length) {
      await query(`UPDATE staff_notifications SET read_at = NOW() WHERE user_id = $1 AND id = ANY($2::bigint[]) AND read_at IS NULL`, [req.user.id, ids]);
    } else {
      await query(`UPDATE staff_notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`, [req.user.id]);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

module.exports = router;
