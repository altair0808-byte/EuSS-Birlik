const express = require('express');
const db = require('../db');
const { authMiddleware, requireRole } = require('./auth');
const { makeUploader } = require('../utils/upload');

const router = express.Router();
const uploadMaterial = makeUploader('materials');

// List courses (all authenticated users can see titles; employees see only assigned ones via assignments endpoint)
router.get('/', authRequired, (req, res) => {
  const rows = db.prepare(`SELECT * FROM courses ORDER BY created_at DESC`).all();
  res.json(rows);
});

router.get('/:id', authRequired, (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course) return res.status(404).json({ error: 'not_found' });
  const questions = db.prepare('SELECT * FROM questions WHERE course_id = ? ORDER BY sort_order').all(req.params.id);
  // Don't leak correct_index to employees
  const safeQuestions = req.user.role === 'employee'
    ? questions.map(q => ({ id: q.id, question_ru: q.question_ru, question_kz: q.question_kz, options_ru: JSON.parse(q.options_ru), options_kz: JSON.parse(q.options_kz) }))
    : questions.map(q => ({ ...q, options_ru: JSON.parse(q.options_ru), options_kz: JSON.parse(q.options_kz) }));
  res.json({ course, questions: safeQuestions });
});

router.post('/', authRequired, requireRole('admin', 'superadmin'), (req, res) => {
  const { title_ru, title_kz, description_ru, description_kz, video_url, time_limit_minutes, pass_score_percent, validity_months } = req.body;
  if (!title_ru || !title_kz) return res.status(400).json({ error: 'missing_fields' });
  const info = db.prepare(`INSERT INTO courses (title_ru, title_kz, description_ru, description_kz, video_url, time_limit_minutes, pass_score_percent, validity_months, created_by)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(title_ru, title_kz, description_ru || '', description_kz || '', video_url || '',
         time_limit_minutes || 20, pass_score_percent || 80, validity_months || 12, req.user.id);
  res.json({ id: info.lastInsertRowid });
});

router.put('/:id', authRequired, requireRole('admin', 'superadmin'), (req, res) => {
  const { title_ru, title_kz, description_ru, description_kz, video_url, time_limit_minutes, pass_score_percent, validity_months } = req.body;
  db.prepare(`UPDATE courses SET title_ru=?, title_kz=?, description_ru=?, description_kz=?, video_url=?, time_limit_minutes=?, pass_score_percent=?, validity_months=? WHERE id=?`)
    .run(title_ru, title_kz, description_ru || '', description_kz || '', video_url || '',
         time_limit_minutes || 20, pass_score_percent || 80, validity_months || 12, req.params.id);
  res.json({ ok: true });
});

router.delete('/:id', authRequired, requireRole('superadmin'), (req, res) => {
  db.prepare('DELETE FROM courses WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/:id/material', authRequired, requireRole('admin', 'superadmin'), uploadMaterial.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const p = `/uploads/materials/${req.file.filename}`;
  db.prepare('UPDATE courses SET material_pdf_path = ? WHERE id = ?').run(p, req.params.id);
  res.json({ ok: true, path: p });
});

// Questions management
router.post('/:id/questions', authRequired, requireRole('admin', 'superadmin'), (req, res) => {
  const { question_ru, question_kz, options_ru, options_kz, correct_index, sort_order } = req.body;
  if (!question_ru || !question_kz || !Array.isArray(options_ru) || !Array.isArray(options_kz)) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  const info = db.prepare(`INSERT INTO questions (course_id, question_ru, question_kz, options_ru, options_kz, correct_index, sort_order)
                            VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(req.params.id, question_ru, question_kz, JSON.stringify(options_ru), JSON.stringify(options_kz), correct_index, sort_order || 0);
  res.json({ id: info.lastInsertRowid });
});

router.put('/questions/:qid', authRequired, requireRole('admin', 'superadmin'), (req, res) => {
  const { question_ru, question_kz, options_ru, options_kz, correct_index, sort_order } = req.body;
  db.prepare(`UPDATE questions SET question_ru=?, question_kz=?, options_ru=?, options_kz=?, correct_index=?, sort_order=? WHERE id=?`)
    .run(question_ru, question_kz, JSON.stringify(options_ru), JSON.stringify(options_kz), correct_index, sort_order || 0, req.params.qid);
  res.json({ ok: true });
});

router.delete('/questions/:qid', authRequired, requireRole('admin', 'superadmin'), (req, res) => {
  db.prepare('DELETE FROM questions WHERE id = ?').run(req.params.qid);
  res.json({ ok: true });
});

module.exports = router;
