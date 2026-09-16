const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { authRequired, requireRole } = require('./auth');
const { generateCertificatePdf } = require('./certificate');

async function getNextCertNumber() {
  const result = await query(`SELECT certificate_number FROM assignments WHERE certificate_number IS NOT NULL`);
  let maxNum = 0;
  for (const r of result.rows) {
    const match = (r.certificate_number || '').match(/^CERT-(\d+)$/i);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > maxNum) maxNum = n;
    }
  }
  return `CERT-${String(maxNum + 1).padStart(4, '0')}`;
}

// Last numbers
router.get('/last-numbers', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const lastProtocol = await query(`SELECT protocol_number FROM assignments ORDER BY id DESC LIMIT 1`);
    const nextCert = await getNextCertNumber();
    res.json({
      last_protocol_number: lastProtocol.rows[0]?.protocol_number || '—',
      next_certificate_number: nextCert
    });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Create assignment
router.post('/', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  const { user_id, course_id, protocol_number, protocol_date } = req.body;
  if (!user_id || !course_id || !protocol_number || !protocol_date) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  try {
    const result = await query(`
      INSERT INTO assignments (user_id, course_id, protocol_number, protocol_date, assigned_by)
      VALUES ($1, $2, $3, $4, $5) RETURNING id
    `, [user_id, course_id, protocol_number, protocol_date, req.user.id]);
    res.json({ id: result.rows[0].id });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Employee's own assignments
router.get('/mine', authRequired, async (req, res) => {
  try {
    const result = await query(`
      SELECT a.*, c.title_ru, c.title_kz, c.time_limit_minutes, c.pass_score_percent,
             c.material_pdf_path, c.video_url, c.description_ru, c.description_kz
      FROM assignments a
      JOIN courses c ON c.id = a.course_id
      WHERE a.user_id = $1
      ORDER BY a.created_at DESC
    `, [req.user.id]);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// List all assignments
router.get('/', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { status, user_id, course_id, object, department, q, date_from, date_to } = req.query;
    let sql = `
      SELECT a.*, u.last_name, u.first_name, u.object, u.department, u.position,
             c.title_ru, c.title_kz, c.pass_score_percent
      FROM assignments a
      JOIN users u ON u.id = a.user_id
      JOIN courses c ON c.id = a.course_id
      WHERE 1=1
    `;
    const params = [];
    if (status) { params.push(status); sql += ` AND a.status = $${params.length}`; }
    if (user_id) { params.push(user_id); sql += ` AND a.user_id = $${params.length}`; }
    if (course_id) { params.push(course_id); sql += ` AND a.course_id = $${params.length}`; }
    if (object) { params.push(object); sql += ` AND u.object = $${params.length}`; }
    if (department) { params.push(department); sql += ` AND u.department = $${params.length}`; }
    if (q) {
      params.push(`%${q}%`);
      sql += ` AND (u.last_name ILIKE $${params.length} OR u.first_name ILIKE $${params.length} OR u.login ILIKE $${params.length})`;
    }
    // Дата прохождения теста (test_date) — используется для журнала по датам и календаря
    if (date_from) { params.push(date_from); sql += ` AND a.test_date >= $${params.length}`; }
    if (date_to) { params.push(date_to + 'T23:59:59.999Z'); sql += ` AND a.test_date <= $${params.length}`; }
    sql += ' ORDER BY a.created_at DESC';

    const result = await query(sql, params);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Assignments whose certificate is expiring soon (or already expired) — for admin dashboard widget
router.get('/expiring', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const days = Number(req.query.days) || 30;
    const result = await query(`
      SELECT a.*, u.last_name, u.first_name, u.object, u.department, u.position,
             c.title_ru, c.title_kz
      FROM assignments a
      JOIN users u ON u.id = a.user_id
      JOIN courses c ON c.id = a.course_id
      WHERE a.status = 'passed'
        AND a.next_test_date IS NOT NULL
        AND a.next_test_date::timestamptz <= NOW() + ($1 || ' days')::interval
      ORDER BY a.next_test_date::timestamptz ASC
    `, [String(days)]);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Start test
router.post('/:id/start', authRequired, async (req, res) => {
  try {
    const aRes = await query('SELECT * FROM assignments WHERE id = $1', [req.params.id]);
    const a = aRes.rows[0];
    if (!a) return res.status(404).json({ error: 'not_found' });
    if (req.user.role === 'employee' && a.user_id !== req.user.id) {
      return res.status(403).json({ error: 'forbidden' });
    }
    if (a.status === 'passed') return res.status(400).json({ error: 'already_passed' });
    if (a.attempts_used > 0 && !a.retake_allowed) {
      return res.status(400).json({ error: 'retake_not_allowed' });
    }

    await query(
      `UPDATE assignments SET status='in_progress', attempts_used = attempts_used + 1, retake_allowed = 0 WHERE id = $1`,
      [req.params.id]
    );

    const questionsRes = await query('SELECT id, course_id, question_ru, question_kz, options_ru, options_kz FROM questions WHERE course_id = $1', [a.course_id]);
    res.json({ ok: true, questions: questionsRes.rows });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Submit test
router.post('/:id/submit', authRequired, async (req, res) => {
  try {
    const aRes = await query('SELECT * FROM assignments WHERE id = $1', [req.params.id]);
    const a = aRes.rows[0];
    if (!a) return res.status(404).json({ error: 'not_found' });

    const cRes = await query('SELECT * FROM courses WHERE id = $1', [a.course_id]);
    const course = cRes.rows[0];
    const qRes = await query('SELECT * FROM questions WHERE course_id = $1', [a.course_id]);
    const questions = qRes.rows;

    const { answers, focus_violations } = req.body;
    let correctCount = 0;
    for (const q of questions) {
      if (answers && answers[q.id] === q.correct_index) correctCount++;
    }

    const total = questions.length || 1;
    const scorePercent = Math.round((correctCount / total) * 100);
    const passed = scorePercent >= course.pass_score_percent;

    let certNum = a.certificate_number;
    if (passed && !certNum) {
      certNum = await getNextCertNumber();
    }

    const now = new Date();
    const testDate = now.toISOString();
    const nextDate = new Date(now.setMonth(now.getMonth() + (course.validity_months || 12))).toISOString();

    await query(`
      UPDATE assignments
      SET status = $1, score_percent = $2, focus_violations = $3,
          certificate_number = $4, test_date = $5, next_test_date = $6
      WHERE id = $7
    `, [passed ? 'passed' : 'failed', scorePercent, focus_violations || 0, certNum, testDate, nextDate, a.id]);

    res.json({ passed, scorePercent, certificate_number: certNum });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Allow retake
router.post('/:id/allow-retake', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    await query(`UPDATE assignments SET retake_allowed = 1, status = 'pending' WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Delete assignment
router.delete('/:id', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    await query('DELETE FROM assignments WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// PDF certificate route directly on assignments
router.get('/:id/certificate.pdf', authRequired, async (req, res) => {
  try {
    const aRes = await query('SELECT * FROM assignments WHERE id = $1', [req.params.id]);
    const assignment = aRes.rows[0];
    if (!assignment || !assignment.certificate_number) return res.status(404).send('Not found');

    const uRes = await query('SELECT * FROM users WHERE id = $1', [assignment.user_id]);
    const user = uRes.rows[0];
    const cRes = await query('SELECT * FROM courses WHERE id = $1', [assignment.course_id]);
    const course = cRes.rows[0];
    const sRes = await query('SELECT * FROM settings WHERE id = 1');
    const settings = sRes.rows[0] || {};

    const lang = req.query.lang || 'ru';
    generateCertificatePdf(res, { assignment, user, course, settings, lang });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

module.exports = router;
