const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { authRequired, requireRole } = require('./auth');
const { makeMemoryUploader } = require('../upload');
const supabaseStorage = require('../supabaseStorage');

const imageUpload = makeMemoryUploader({
  maxSizeMB: 8,
  fileFilter: (req, file, cb) => {
    const ok = /^image\//i.test(file.mimetype || '') || /\.(png|jpe?g|webp|gif|svg)$/i.test(file.originalname || '');
    if (ok) return cb(null, true);
    cb(new Error('bad_file_type'));
  }
});

// Загружает файл (буфер из памяти) в Supabase Storage и возвращает публичную
// ссылку. Файл загружается ОДИН раз — дальше в базе хранится только ссылка,
// повторных загрузок того же файла при сохранении других настроек не требуется.
async function uploadToStorage(folder, file) {
  if (!supabaseStorage.isConfigured()) {
    throw new Error(
      'Supabase Storage не настроен: задайте SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY в переменных окружения'
    );
  }
  const { url } = await supabaseStorage.uploadBuffer(folder, file.originalname, file.buffer, file.mimetype);
  return url;
}

router.get('/', authRequired, async (req, res) => {
  try {
    const result = await query('SELECT * FROM settings WHERE id = 1');
    res.json(result.rows[0] || {});
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

router.get('/public', async (req, res) => {
  try {
    const result = await query('SELECT company_name, logo_path, logo_data FROM settings WHERE id = 1');
    res.json(result.rows[0] || {});
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Настройки комиссии и нумерации. Комиссия — два председателя (без "членов
// комиссии"): у каждого своё ФИО, должность и подпись. На сертификате
// используется только ОДИН из них — тот, что выбран переключателем
// active_chairman (1 или 2) — его данные и печать; второй не показывается.
router.put('/', authRequired, requireRole('superadmin'), async (req, res) => {
  const {
    company_name,
    chairman1_name, chairman1_position,
    chairman2_name, chairman2_position,
    active_chairman,
    protocol_prefix, protocol_next_number,
    certificate_prefix, certificate_digits, certificate_next_number
  } = req.body;

  try {
    const actChair = active_chairman !== undefined ? (parseInt(active_chairman, 10) === 2 ? 2 : 1) : null;
    const result = await query(
      `UPDATE settings SET
        company_name = COALESCE($1, company_name),
        chairman1_name = COALESCE($2, chairman1_name),
        chairman1_position = COALESCE($3, chairman1_position),
        chairman2_name = COALESCE($4, chairman2_name),
        chairman2_position = COALESCE($5, chairman2_position),
        active_chairman = COALESCE($6, active_chairman),
        protocol_prefix = COALESCE($7, protocol_prefix),
        protocol_next_number = COALESCE($8, protocol_next_number),
        certificate_prefix = COALESCE($9, certificate_prefix),
        certificate_digits = COALESCE($10, certificate_digits),
        certificate_next_number = COALESCE($11, certificate_next_number)
      WHERE id = 1
      RETURNING *`,
      [
        company_name,
        chairman1_name, chairman1_position,
        chairman2_name, chairman2_position,
        actChair,
        protocol_prefix,
        protocol_next_number !== undefined ? Number(protocol_next_number) : null,
        certificate_prefix,
        certificate_digits !== undefined ? Number(certificate_digits) : null,
        certificate_next_number !== undefined ? Number(certificate_next_number) : null
      ]
    );
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

router.post('/logo', authRequired, requireRole('superadmin'), (req, res) => {
  imageUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: 'bad_file', message: err.message || 'Не удалось загрузить файл' });
    if (!req.file) return res.status(400).json({ error: 'no_file', message: 'Файл не выбран' });
    try {
      const url = await uploadToStorage('logo', req.file);
      const result = await query(
        'UPDATE settings SET logo_path = $1, logo_data = NULL WHERE id = 1 RETURNING *',
        [url]
      );
      res.json(result.rows[0]);
    } catch (e) {
      res.status(500).json({ error: 'upload_error', message: e.message, details: e.message });
    }
  });
});

router.post('/stamp', authRequired, requireRole('superadmin'), (req, res) => {
  imageUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: 'bad_file', message: err.message || 'Не удалось загрузить файл' });
    if (!req.file) return res.status(400).json({ error: 'no_file', message: 'Файл не выбран' });
    try {
      const url = await uploadToStorage('stamp', req.file);
      const result = await query(
        'UPDATE settings SET stamp_path = $1, stamp_data = NULL WHERE id = 1 RETURNING *',
        [url]
      );
      res.json(result.rows[0]);
    } catch (e) {
      res.status(500).json({ error: 'upload_error', message: e.message, details: e.message });
    }
  });
});

// Подпись одного из двух председателей: ?chairman=1 или ?chairman=2
router.post('/signature', authRequired, requireRole('superadmin'), (req, res) => {
  imageUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: 'bad_file', message: err.message || 'Не удалось загрузить файл' });
    if (!req.file) return res.status(400).json({ error: 'no_file', message: 'Файл не выбран' });
    const chairNum = req.query.chairman === '2' ? 2 : 1;
    const colSig = chairNum === 2 ? 'chairman2_signature' : 'chairman1_signature';

    try {
      const url = await uploadToStorage('signature', req.file);
      const result = await query(
        `UPDATE settings SET ${colSig} = $1 WHERE id = 1 RETURNING *`,
        [url]
      );
      res.json(result.rows[0]);
    } catch (e) {
      res.status(500).json({ error: 'upload_error', message: e.message, details: e.message });
    }
  });
});

module.exports = router;
