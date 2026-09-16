const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { authRequired, requireRole } = require('./auth');
const { makeUploader } = require('../upload');

const uploadMaterial = makeUploader('materials');

// List courses
router.get('/', authRequired, async (req, res) => {
  try {
    const result = await query(`
      SELECT c.*, (SELECT COUNT(*)::int FROM questions q WHERE q.course_id = c.id) as questions_count
      FROM courses c ORDER BY c.created_at DESC
    `);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Single course with questions
router.get('/:id', authRequired, async (req, res) => {
  try {
    const courseRes = await query('SELECT * FROM courses WHERE id = $1', [req.params.id]);
    const course = courseRes.rows[0];
    if (!course) return res.status(404).json({ error: 'not_found' });
    const questionsRes = await query('SELECT * FROM questions WHERE course_id = $1 ORDER BY sort_order', [req.params.id]);
    res.json({ course, questions: questionsRes.rows });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Create course
router.post('/', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  const { title_ru, title_kz, description_ru, description_kz, video_url, time_limit_minutes, pass_score_percent, validity_months } = req.body;
  if (!title_ru || !title_kz) return res.status(400).json({ error: 'missing_title' });

  try {
    const result = await query(`
      INSERT INTO courses (title_ru, title_kz, description_ru, description_kz, video_url, time_limit_minutes, pass_score_percent, validity_months, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id
    `, [
      title_ru, title_kz, description_ru || '', description_kz || '', video_url || '',
      time_limit_minutes || 20, pass_score_percent || 80, validity_months || 12, req.user.id
    ]);
    res.json({ id: result.rows[0].id });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Update course
router.put('/:id', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  const { title_ru, title_kz, description_ru, description_kz, video_url, time_limit_minutes, pass_score_percent, validity_months } = req.body;
  try {
    await query(`
      UPDATE courses
      SET title_ru=$1, title_kz=$2, description_ru=$3, description_kz=$4, video_url=$5, time_limit_minutes=$6, pass_score_percent=$7, validity_months=$8
      WHERE id=$9
    `, [
      title_ru, title_kz, description_ru, description_kz, video_url, time_limit_minutes, pass_score_percent, validity_months, req.params.id
    ]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Delete course
router.delete('/:id', authRequired, requireRole('superadmin'), async (req, res) => {
  try {
    await query('DELETE FROM courses WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Upload material PDF
router.post('/:id/material', authRequired, requireRole('admin', 'superadmin'), uploadMaterial.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const p = `/uploads/materials/${req.file.filename}`;
  try {
    await query('UPDATE courses SET material_pdf_path = $1 WHERE id = $2', [p, req.params.id]);
    res.json({ material_pdf_path: p });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Add question
router.post('/:id/questions', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  const { question_ru, question_kz, options_ru, options_kz, correct_index, sort_order } = req.body;
  try {
    const result = await query(`
      INSERT INTO questions (course_id, question_ru, question_kz, options_ru, options_kz, correct_index, sort_order)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
    `, [
      req.params.id, question_ru, question_kz,
      typeof options_ru === 'string' ? options_ru : JSON.stringify(options_ru),
      typeof options_kz === 'string' ? options_kz : JSON.stringify(options_kz),
      correct_index, sort_order || 0
    ]);
    res.json({ id: result.rows[0].id });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Update question
router.put('/:id/questions/:qid', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  const { question_ru, question_kz, options_ru, options_kz, correct_index, sort_order } = req.body;
  try {
    await query(`
      UPDATE questions
      SET question_ru=$1, question_kz=$2, options_ru=$3, options_kz=$4, correct_index=$5, sort_order=$6
      WHERE id=$7
    `, [
      question_ru, question_kz,
      typeof options_ru === 'string' ? options_ru : JSON.stringify(options_ru),
      typeof options_kz === 'string' ? options_kz : JSON.stringify(options_kz),
      correct_index, sort_order || 0, req.params.qid
    ]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Delete question
router.delete('/:id/questions/:qid', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    await query('DELETE FROM questions WHERE id = $1', [req.params.qid]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

module.exports = router;
