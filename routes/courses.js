const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { query, pool } = require('../db');
const { authRequired, requireRole } = require('./auth');
const { makeUploader } = require('../upload');

// Материалы курса — презентация или PDF-методичка
const uploadMaterial = makeUploader('materials', {
  maxSizeMB: 50,
  fileFilter: (req, file, cb) => {
    const okExt = /\.(pdf|ppt|pptx)$/i.test(file.originalname || '');
    const okMime = /pdf|presentation|powerpoint/i.test(file.mimetype || '');
    if (okExt || okMime) return cb(null, true);
    cb(new Error('bad_file_type'));
  }
});

// Видео курса — отдельный файл (необязательный, вместо/вместе со ссылкой)
const uploadVideo = makeUploader('videos', {
  maxSizeMB: 300,
  fileFilter: (req, file, cb) => {
    const okExt = /\.(mp4|webm|mov|avi|mkv|m4v)$/i.test(file.originalname || '');
    const okMime = /^video\//i.test(file.mimetype || '');
    if (okExt || okMime) return cb(null, true);
    cb(new Error('bad_file_type'));
  }
});

// Excel-файл с базой тестовых вопросов (билеты/варианты)
const uploadImport = makeUploader('imports');

const MAX_VARIANTS = 10;
const QUESTIONS_PER_VARIANT = 10;

function clampVariant(n) {
  const v = parseInt(n, 10);
  if (!v || v < 1) return 1;
  if (v > MAX_VARIANTS) return MAX_VARIANTS;
  return v;
}

// ===================== Список / карточка курса =====================

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

// Excel-шаблон для загрузки тестов (10 билетов x 10 вопросов x 4 варианта ответа)
// Должен быть объявлен раньше '/:id', иначе Express примет "questions-template.xlsx" за id
router.get('/questions-template.xlsx', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Тесты');
    ws.columns = [
      { header: 'Вариант (1-10)', key: 'variant', width: 14 },
      { header: 'Вопрос RU', key: 'qru', width: 45 },
      { header: 'Вопрос KZ', key: 'qkz', width: 45 },
      { header: 'Ответ 1 RU', key: 'o1ru', width: 25 },
      { header: 'Ответ 2 RU', key: 'o2ru', width: 25 },
      { header: 'Ответ 3 RU', key: 'o3ru', width: 25 },
      { header: 'Ответ 4 RU', key: 'o4ru', width: 25 },
      { header: 'Ответ 1 KZ', key: 'o1kz', width: 25 },
      { header: 'Ответ 2 KZ', key: 'o2kz', width: 25 },
      { header: 'Ответ 3 KZ', key: 'o3kz', width: 25 },
      { header: 'Ответ 4 KZ', key: 'o4kz', width: 25 },
      { header: 'Правильный (1-4)', key: 'correct', width: 16 }
    ];
    ws.getRow(1).font = { bold: true };
    ws.addRow({
      variant: 1,
      qru: 'Пример вопроса на русском?',
      qkz: 'Мысал сұрақ қазақша?',
      o1ru: 'Вариант ответа 1', o2ru: 'Вариант ответа 2', o3ru: 'Вариант ответа 3', o4ru: 'Вариант ответа 4',
      o1kz: 'Жауап нұсқасы 1', o2kz: 'Жауап нұсқасы 2', o3kz: 'Жауап нұсқасы 3', o4kz: 'Жауап нұсқасы 4',
      correct: 1
    });
    ws.addRow({
      variant: 1,
      qru: '... (ещё 9 вопросов для варианта 1, всего рекомендуется 10)',
      qkz: '', o1ru: '', o2ru: '', o3ru: '', o4ru: '', o1kz: '', o2kz: '', o3kz: '', o4kz: '', correct: ''
    });

    const notes = wb.addWorksheet('Инструкция');
    notes.columns = [{ key: 'a', width: 100 }];
    [
      'Инструкция по заполнению файла для загрузки тестов:',
      '1. Заполните лист "Тесты", по одной строке на каждый вопрос.',
      `2. Всего рекомендуется до ${MAX_VARIANTS} вариантов (билетов), по ${QUESTIONS_PER_VARIANT} вопросов в каждом.`,
      '3. Колонка "Вариант" — номер билета от 1 до 10, все вопросы одного билета должны иметь одинаковый номер.',
      '4. Заполните все 4 варианта ответа на русском и казахском языках.',
      '5. В колонке "Правильный (1-4)" укажите номер верного варианта ответа (позиция в списке из 4 ответов).',
      '6. Загрузите готовый файл в карточке курса на вкладке "Тесты" кнопкой "Загрузить тест из Excel".',
      '7. При загрузке можно выбрать: заменить всю базу вопросов курса или добавить к уже существующим.'
    ].forEach(line => notes.addRow([line]));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="test_template.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    res.status(500).json({ error: 'template_failed', details: e.message });
  }
});

// Single course with questions (includes correct_index — admin/superadmin only,
// otherwise employees could fetch the answer key before taking the test)
router.get('/:id', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const courseRes = await query('SELECT * FROM courses WHERE id = $1', [req.params.id]);
    const course = courseRes.rows[0];
    if (!course) return res.status(404).json({ error: 'not_found' });
    const questionsRes = await query(
      'SELECT * FROM questions WHERE course_id = $1 ORDER BY variant_number, sort_order',
      [req.params.id]
    );
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

// ===================== Материалы (презентация/PDF) =====================

// Upload material file
router.post('/:id/material', authRequired, requireRole('admin', 'superadmin'), (req, res) => {
  uploadMaterial.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: 'bad_file_type', message: 'Допустимы файлы PDF, PPT или PPTX' });
    if (!req.file) return res.status(400).json({ error: 'no_file' });
    const p = `/uploads/materials/${req.file.filename}`;
    try {
      await query('UPDATE courses SET material_pdf_path = $1 WHERE id = $2', [p, req.params.id]);
      res.json({ material_pdf_path: p });
    } catch (e) {
      res.status(500).json({ error: 'db_error', details: e.message });
    }
  });
});

// Remove material file (course can exist without materials)
router.delete('/:id/material', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    await query('UPDATE courses SET material_pdf_path = NULL WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// ===================== Видео (файл или ссылка, необязательно) =====================

// Upload video file
router.post('/:id/video', authRequired, requireRole('admin', 'superadmin'), (req, res) => {
  uploadVideo.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: 'bad_file_type', message: 'Допустимы видеофайлы (mp4, webm, mov и т.п.)' });
    if (!req.file) return res.status(400).json({ error: 'no_file' });
    const p = `/uploads/videos/${req.file.filename}`;
    try {
      await query('UPDATE courses SET video_path = $1 WHERE id = $2', [p, req.params.id]);
      res.json({ video_path: p });
    } catch (e) {
      res.status(500).json({ error: 'db_error', details: e.message });
    }
  });
});

// Remove video (file and/or link) — video is optional and may simply not exist
router.delete('/:id/video', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    await query('UPDATE courses SET video_path = NULL, video_url = \'\' WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// ===================== Тесты: варианты (билеты) =====================

// Сводка по вариантам — сколько вопросов заполнено в каждом из 10 билетов
router.get('/:id/variants', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const result = await query(
      'SELECT variant_number, COUNT(*)::int AS count FROM questions WHERE course_id = $1 GROUP BY variant_number ORDER BY variant_number',
      [req.params.id]
    );
    const counts = {};
    result.rows.forEach(r => { counts[r.variant_number] = r.count; });
    const variants = [];
    for (let i = 1; i <= MAX_VARIANTS; i++) {
      variants.push({ variant_number: i, count: counts[i] || 0 });
    }
    res.json({ variants, target_per_variant: QUESTIONS_PER_VARIANT, max_variants: MAX_VARIANTS });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Bulk import вопросов из Excel — автоматическая загрузка теста
// mode=replace (по умолчанию) удаляет все текущие вопросы курса перед загрузкой; mode=append — добавляет к существующим
router.post('/:id/questions/import', authRequired, requireRole('admin', 'superadmin'), (req, res) => {
  uploadImport.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: 'bad_file_type', message: 'Загрузите файл Excel (.xlsx)' });
    if (!req.file) return res.status(400).json({ error: 'no_file' });

    const mode = req.query.mode === 'append' ? 'append' : 'replace';
    const headerMap = {
      'вариант': 'variant', 'вариант (1-10)': 'variant', 'билет': 'variant', '№ варианта': 'variant', 'номер варианта': 'variant',
      'вопрос ru': 'question_ru', 'вопрос (ru)': 'question_ru', 'вопрос рус': 'question_ru',
      'вопрос kz': 'question_kz', 'вопрос (kz)': 'question_kz', 'вопрос қаз': 'question_kz',
      'ответ 1 ru': 'o1ru', 'ответ 2 ru': 'o2ru', 'ответ 3 ru': 'o3ru', 'ответ 4 ru': 'o4ru',
      'ответ 1 kz': 'o1kz', 'ответ 2 kz': 'o2kz', 'ответ 3 kz': 'o3kz', 'ответ 4 kz': 'o4kz',
      'правильный': 'correct', 'правильный (1-4)': 'correct', 'правильный ответ': 'correct', 'номер правильного': 'correct'
    };

    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(req.file.path);
      const ws = wb.worksheets[0];
      if (!ws) return res.status(400).json({ error: 'empty_file' });

      const headerRow = ws.getRow(1);
      const colByField = {};
      headerRow.eachCell((cell, colNumber) => {
        const key = String(cell.value || '').trim().toLowerCase();
        if (headerMap[key]) colByField[headerMap[key]] = colNumber;
      });

      const required = ['variant', 'question_ru', 'question_kz', 'o1ru', 'o2ru', 'o3ru', 'o4ru', 'o1kz', 'o2kz', 'o3kz', 'o4kz', 'correct'];
      const missing = required.filter(f => !colByField[f]);
      if (missing.length) {
        return res.status(400).json({
          error: 'missing_columns',
          message: 'В файле не хватает колонок. Скачайте актуальный шаблон и заполните его без изменения заголовков.'
        });
      }

      const rows = [];
      const errors = [];
      for (let r = 2; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const get = (f) => String(row.getCell(colByField[f]).value ?? '').trim();

        const variantRaw = get('variant');
        const question_ru = get('question_ru');
        const question_kz = get('question_kz');
        if (!variantRaw && !question_ru && !question_kz) continue; // пустая строка

        const variant = parseInt(variantRaw, 10);
        if (!variant || variant < 1 || variant > MAX_VARIANTS) {
          errors.push(`Строка ${r}: номер варианта должен быть от 1 до ${MAX_VARIANTS}`);
          continue;
        }
        if (!question_ru || !question_kz) {
          errors.push(`Строка ${r}: не заполнен текст вопроса (RU/KZ)`);
          continue;
        }
        const opts_ru = [get('o1ru'), get('o2ru'), get('o3ru'), get('o4ru')];
        const opts_kz = [get('o1kz'), get('o2kz'), get('o3kz'), get('o4kz')];
        if (opts_ru.some(o => !o) || opts_kz.some(o => !o)) {
          errors.push(`Строка ${r}: заполните все 4 варианта ответа на RU и KZ`);
          continue;
        }
        const correct = parseInt(get('correct'), 10);
        if (!correct || correct < 1 || correct > 4) {
          errors.push(`Строка ${r}: номер правильного ответа должен быть от 1 до 4`);
          continue;
        }

        rows.push({ variant, question_ru, question_kz, opts_ru, opts_kz, correct_index: correct - 1 });
      }

      if (!rows.length) {
        return res.status(400).json({ error: 'no_valid_rows', errors });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (mode === 'replace') {
          await client.query('DELETE FROM questions WHERE course_id = $1', [req.params.id]);
        }
        const sortCounters = {};
        for (const row of rows) {
          sortCounters[row.variant] = (sortCounters[row.variant] || 0) + 1;
          await client.query(`
            INSERT INTO questions (course_id, question_ru, question_kz, options_ru, options_kz, correct_index, sort_order, variant_number)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `, [
            req.params.id, row.question_ru, row.question_kz,
            JSON.stringify(row.opts_ru), JSON.stringify(row.opts_kz),
            row.correct_index, sortCounters[row.variant], row.variant
          ]);
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }

      res.json({ imported: rows.length, skipped: errors.length, errors, mode });
    } catch (e) {
      console.error('Import questions error:', e);
      res.status(500).json({ error: 'import_failed', details: e.message });
    }
  });
});

// Add question
router.post('/:id/questions', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  const { question_ru, question_kz, options_ru, options_kz, correct_index, sort_order, variant_number } = req.body;
  try {
    const result = await query(`
      INSERT INTO questions (course_id, question_ru, question_kz, options_ru, options_kz, correct_index, sort_order, variant_number)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id
    `, [
      req.params.id, question_ru, question_kz,
      typeof options_ru === 'string' ? options_ru : JSON.stringify(options_ru),
      typeof options_kz === 'string' ? options_kz : JSON.stringify(options_kz),
      correct_index, sort_order || 0, clampVariant(variant_number)
    ]);
    res.json({ id: result.rows[0].id });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Update question
router.put('/:id/questions/:qid', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  const { question_ru, question_kz, options_ru, options_kz, correct_index, sort_order, variant_number } = req.body;
  try {
    await query(`
      UPDATE questions
      SET question_ru=$1, question_kz=$2, options_ru=$3, options_kz=$4, correct_index=$5, sort_order=$6, variant_number=$7
      WHERE id=$8
    `, [
      question_ru, question_kz,
      typeof options_ru === 'string' ? options_ru : JSON.stringify(options_ru),
      typeof options_kz === 'string' ? options_kz : JSON.stringify(options_kz),
      correct_index, sort_order || 0, clampVariant(variant_number), req.params.qid
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

// Delete all questions of one variant (удобно перед ручным пересозданием билета)
router.delete('/:id/variants/:variant', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    await query('DELETE FROM questions WHERE course_id = $1 AND variant_number = $2', [req.params.id, clampVariant(req.params.variant)]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

module.exports = router;
