const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('./auth');

const router = express.Router();

const CERT_PREFIX = 'У-';

function nextCertificateNumber() {
  const rows = db.prepare(`SELECT certificate_number FROM assignments WHERE certificate_number IS NOT NULL`).all();
  let max = 0;
  for (const r of rows) {
    const m = String(r.certificate_number).match(/(\d+)/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  const next = max + 1;
  return `${CERT_PREFIX}${String(next).padStart(4, '0')}`;
}

// Hints for admin panel: last protocol number & last certificate number
router.get('/last-numbers', authRequired, requireRole('admin', 'superadmin'), (req, res) => {
  const lastProtocol = db.prepare(`SELECT protocol_number FROM assignments ORDER BY id DESC LIMIT 1`).get();
  const certRows = db.prepare(`SELECT certificate_number FROM assignments WHERE certificate_number IS NOT NULL`).all();
  let max = 0, maxStr = null;
  for (const r of certRows) {
    const m = String(r.certificate_number).match(/(\d+)/);
    if (m && parseInt(m[1], 10) > max) { max = parseInt(m[1], 10); maxStr = r.certificate_number; }
  }
  res.json({
    last_protocol_number: lastProtocol ? lastProtocol.protocol_number : null,
    last_certificate_number: maxStr,
    next_certificate_number_preview: `${CERT_PREFIX}${String(max + 1).padStart(4, '0')}`
  });
});

// Admin: create assignment
router.post('/', authRequired, requireRole('admin', 'superadmin'), (req, res) => {
  const { user_id, course_id, protocol_number, protocol_date } = req.body;
  if (!user_id || !course_id || !protocol_number || !protocol_date) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  const info = db.prepare(`INSERT INTO assignments (user_id, course_id, protocol_number, protocol_date, assigned_by)
                            VALUES (?, ?, ?, ?, ?)`)
    .run(user_id, course_id, protocol_number, protocol_date, req.user.id);
  res.json({ id: info.lastInsertRowid });
});

// Employee: my assignments
router.get('/mine', authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, c.title_ru, c.title_kz, c.time_limit_minutes, c.pass_score_percent
    FROM assignments a JOIN courses c ON c.id = a.course_id
    WHERE a.user_id = ? ORDER BY a.created_at DESC
  `).all(req.user.id);
  res.json(rows);
});

// Admin/superadmin: journal with filters
router.get('/', authRequired, requireRole('admin', 'superadmin'), (req, res) => {
  const { protocol_number, object, department, status, has_certificate } = req.query;
  let sql = `
    SELECT a.*, u.last_name, u.first_name, u.object, u.department, u.position, u.login,
           c.title_ru, c.title_kz, c.pass_score_percent
    FROM assignments a
    JOIN users u ON u.id = a.user_id
    JOIN courses c ON c.id = a.course_id
    WHERE 1=1`;
  const params = [];
  if (protocol_number) { sql += ' AND a.protocol_number LIKE ?'; params.push(`%${protocol_number}%`); }
  if (object) { sql += ' AND u.object = ?'; params.push(object); }
  if (department) { sql += ' AND u.department = ?'; params.push(department); }
  if (status) { sql += ' AND a.status = ?'; params.push(status); }
  if (has_certificate === 'yes') sql += ' AND a.certificate_number IS NOT NULL';
  if (has_certificate === 'no') sql += ' AND a.certificate_number IS NULL';
  sql += ' ORDER BY a.created_at DESC';
  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// Start test
router.post('/:id/start', authRequired, (req, res) => {
  const id = Number(req.params.id);
  const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(id);
  if (!a) return res.status(404).json({ error: 'not_found' });
  if (req.user.role === 'employee' && a.user_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  if (a.status === 'passed') return res.status(400).json({ error: 'already_passed' });
  if (a.status === 'failed' && !a.retake_allowed) return res.status(400).json({ error: 'retake_not_allowed' });

  db.prepare(`UPDATE assignments SET status = 'in_progress', attempts_used = attempts_used + 1, retake_allowed = 0 WHERE id = ?`).run(id);
  res.json({ ok: true });
});

// Submit test
router.post('/:id/submit', authRequired, (req, res) => {
  const id = Number(req.params.id);
  const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(id);
  if (!a) return res.status(404).json({ error: 'not_found' });
  if (req.user.role === 'employee' && a.user_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });

  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(a.course_id);
  const questions = db.prepare('SELECT * FROM questions WHERE course_id = ?').all(a.course_id);
  const answers = req.body.answers || {}; // { questionId: chosenIndex }
  const violations = Number(req.body.focus_violations || 0);

  let correctCount = 0;
  for (const q of questions) {
    if (answers[q.id] !== undefined && Number(answers[q.id]) === q.correct_index) {
      correctCount++;
    }
  }

  const scorePercent = questions.length ? Math.round((correctCount / questions.length) * 100) : 0;
  const penalty = Math.min(violations * 2, 20); // 2% за нарушение, макс 20%
  const finalScore = Math.max(0, scorePercent - penalty);
  const passed = finalScore >= course.pass_score_percent;

  let certificateNumber = a.certificate_number;
  if (passed && !certificateNumber) {
    const prior = db.prepare(`
      SELECT certificate_number FROM assignments
      WHERE user_id = ? AND course_id = ? AND certificate_number IS NOT NULL AND id != ?
      ORDER BY id DESC LIMIT 1
    `).get(a.user_id, a.course_id, a.id);
    certificateNumber = prior ? prior.certificate_number : nextCertificateNumber();
  }

  const now = new Date();
  const testDate = now.toISOString().split('T')[0];
  const nextDate = new Date(now);
  nextDate.setMonth(nextDate.getMonth() + (course.validity_months || 12));
  const nextTestDate = nextDate.toISOString().split('T')[0];

  db.prepare(`
    UPDATE assignments
    SET status = ?, score_percent = ?, focus_violations = ?, certificate_number = ?,
        test_date = ?, next_test_date = ?
    WHERE id = ?
  `).run(
    passed ? 'passed' : 'failed',
    finalScore,
    violations,
    passed ? certificateNumber : null,
    testDate,
    passed ? nextTestDate : null,
    id
  );

  res.json({ passed, score_percent: finalScore, certificate_number: passed ? certificateNumber : null });
});

// Admin: allow retake
router.post('/:id/allow-retake', authRequired, requireRole('admin', 'superadmin'), (req, res) => {
  const id = Number(req.params.id);
  db.prepare(`UPDATE assignments SET retake_allowed = 1, status = 'pending' WHERE id = ?`).run(id);
  res.json({ ok: true });
});

// Admin: edit assignment
router.put('/:id', authRequired, requireRole('admin', 'superadmin'), (req, res) => {
  const id = Number(req.params.id);
  const { protocol_number, protocol_date, certificate_number } = req.body;
  db.prepare(`UPDATE assignments SET protocol_number = ?, protocol_date = ?, certificate_number = ? WHERE id = ?`)
    .run(protocol_number, protocol_date, certificate_number || null, id);
  res.json({ ok: true });
});

// Admin: delete assignment
router.delete('/:id', authRequired, requireRole('superadmin'), (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM assignments WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
