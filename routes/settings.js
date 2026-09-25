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

// Настройки комиссии и нумерации сертификатов (нумерация протоколов живёт во вкладке «Протоколы»). Комиссия — два председателя (без "членов
// комиссии"): у каждого своё ФИО, должность и подпись. На сертификате
// используется только ОДИН из них — тот, что выбран переключателем
// active_chairman (1 или 2) — его данные и печать; второй не показывается.
router.put('/', authRequired, requireRole('superadmin'), async (req, res) => {
  const {
    company_name,
    chairman1_name, chairman1_position,
    chairman2_name, chairman2_position,
    active_chairman,
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
        certificate_prefix = COALESCE($7, certificate_prefix),
        certificate_digits = COALESCE($8, certificate_digits),
        certificate_next_number = COALESCE($9, certificate_next_number)
      WHERE id = 1
      RETURNING *`,
      [
        company_name,
        chairman1_name, chairman1_position,
        chairman2_name, chairman2_position,
        actChair,
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

// Справочники «Отдел» / «Должность» (п.1 запроса) — единые списки для выпадающих
// списков в карточке сотрудника, чтобы избежать разнобоя в написании (не «Инженер»,
// «инженер», «Инженер ТБ» и т.п. вперемешку).
router.get('/dictionaries', authRequired, async (req, res) => {
  try {
    const result = await query('SELECT departments_list, positions_list FROM settings WHERE id = 1');
    const row = result.rows[0] || {};
    res.json({
      departments: Array.isArray(row.departments_list) ? row.departments_list : [],
      positions: Array.isArray(row.positions_list) ? row.positions_list : []
    });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Сохраняет справочники целиком (весь список сразу — добавление/удаление значений
// происходит на фронтенде, сюда отправляется итоговый список). Значения очищаются
// от пустых строк и дублей и сортируются по алфавиту.
router.put('/dictionaries', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  const clean = arr => Array.isArray(arr)
    ? [...new Set(arr.map(v => String(v || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'))
    : undefined;
  const departments = clean(req.body.departments);
  const positions = clean(req.body.positions);
  try {
    const result = await query(
      `UPDATE settings SET
        departments_list = COALESCE($1::jsonb, departments_list),
        positions_list = COALESCE($2::jsonb, positions_list)
      WHERE id = 1
      RETURNING departments_list, positions_list`,
      [departments ? JSON.stringify(departments) : null, positions ? JSON.stringify(positions) : null]
    );
    const row = result.rows[0] || {};
    res.json({ departments: row.departments_list || [], positions: row.positions_list || [] });
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
