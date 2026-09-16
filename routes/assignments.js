const express = require('express');
const db = require('../db');
const { authMiddleware, requireRole } = require('./auth');

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
           c.title_ru, c.title_kz
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

// Employee starts test
router.post('/:id/start', authRequired, (req, res) => {
  const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'not_found' });
  if (a.user_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });

  if (a.status === 'passed') return res.status(409).json({ error: 'already_passed' });
  if (a.status === 'failed' && !a.retake_allowed) return res.status(409).json({ error: 'retake_not_allowed' });
  if (a.status === 'in_progress') {
    // resume same attempt
    return res.json({ ok: true, started_at: a.started_at || new Date().toISOString() });
  }

  const startedAt = new Date().toISOString();
  db.prepare(`UPDATE assignments SET status='in_progress', attempts_used = attempts_used + 1, retake_allowed = 0 WHERE id = ?`)
    .run(a.id);
  res.json({ ok: true, started_at: startedAt });
});

// Employee submits test
router.post('/:id/submit', authRequired, (req, res) => {
  const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'not_found' });
  if (a.user_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  if (a.status !== 'in_progress') return res.status(409).json({ error: 'not_in_progress' });

  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(a.course_id);
  const questions = db.prepare('SELECT * FROM questions WHERE course_id = ?').all(a.course_id);

  const { answers, violations, forced } = req.body; // answers: { [questionId]: selectedIndex }
  let correct = 0;
  for (const q of questions) {
    const sel = answers ? answers[q.id] : undefined;
    if (sel !== undefined && Number(sel) === q.correct_index) correct++;
  }
  const total = questions.length || 1;
  const scorePercent = Math.round((correct / total) * 100);
  const isForced = !!forced || (Number(violations) || 0) > 3;
  const finalScore = isForced ? 0 : scorePercent;
  const passed = !isForced && finalScore >= (course.pass_score_percent || 80);

  const testDate = new Date();
  const nextDate = new Date(testDate);
  nextDate.setMonth(nextDate.getMonth() + (course.validity_months || 12));

  let certificateNumber = a.certificate_number; // reuse if already had one (retake of previously certified course)
  if (passed) {
    // reuse existing certificate number for this user+course if one was ever issued, else assign next
    const prior = db.prepare(`
      SELECT certificate_number FROM assignments
      WHERE user_id = ? AND course_id = ? AND certificate_number IS NOT NULL AND id != ?
      ORDER BY id DESC LIMIT 1`).get(a.user_id, a.course_id, a.id);
    certificateNumber = prior ? prior.certificate_number : nextCertificateNumber();
  }

  db.prepare(`
    UPDATE assignments
    SET status = ?, score_percent = ?, focus_violations = ?, certificate_number = ?,
        test_date = ?, next_test_date = ?
    WHERE id = ?
  `).run(
    passed ? 'passed' : 'failed',
    finalScore,
    Number(violations) || 0,
    certificateNumber,
    testDate.toISOString(),
    passed ? nextDate.toISOString() : null,
    a.id
  );

  res.json({ passed, score_percent: finalScore, certificate_number: passed ? certificateNumber : null });
});

// Admin allows retake
router.post('/:id/allow-retake', authRequired, requireRole('admin', 'superadmin'), (req, res) => {
  const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'not_found' });
  db.prepare(`UPDATE assignments SET retake_allowed = 1, status = 'pending' WHERE id = ?`).run(a.id);
  res.json({ ok: true });
});

// Admin can edit protocol number/date
router.put('/:id', authRequired, requireRole('admin', 'superadmin'), (req, res) => {
  const { protocol_number, protocol_date } = req.body;
  const fields = []; const params = [];
  if (protocol_number !== undefined) { fields.push('protocol_number = ?'); params.push(protocol_number); }
  if (protocol_date !== undefined) { fields.push('protocol_date = ?'); params.push(protocol_date); }
  if (!fields.length) return res.json({ ok: true });
  params.push(req.params.id);
  db.prepare(`UPDATE assignments SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

router.delete('/:id', authRequired, requireRole('superadmin'), (req, res) => {
  db.prepare('DELETE FROM assignments WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
