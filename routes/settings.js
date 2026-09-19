const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { authRequired, requireRole } = require('./auth');
const { makeUploader } = require('../upload');

const uploadLogo = makeUploader('logo');
const uploadStamp = makeUploader('stamp');
const uploadSignature = makeUploader('signature');

// Get settings
router.get('/', authRequired, async (req, res) => {
  try {
    const result = await query('SELECT * FROM settings WHERE id = 1');
    res.json(result.rows[0] || {});
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Публичные настройки (без авторизации) — используются для отображения
// логотипа/названия компании на экране входа и в шапке сайта.
router.get('/public', async (req, res) => {
  try {
    const result = await query('SELECT company_name, logo_path FROM settings WHERE id = 1');
    res.json(result.rows[0] || {});
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Update settings
router.put('/', authRequired, requireRole('superadmin'), async (req, res) => {
  const {
    company_name, chairman_name, member2_name, member3_name,
    protocol_prefix, protocol_next_number,
    certificate_prefix, certificate_digits, certificate_next_number
  } = req.body;
  const fields = [];
  const params = [];
  if (company_name !== undefined) { params.push(company_name); fields.push(`company_name = $${params.length}`); }
  if (chairman_name !== undefined) { params.push(chairman_name); fields.push(`chairman_name = $${params.length}`); }
  if (member2_name !== undefined) { params.push(member2_name); fields.push(`member2_name = $${params.length}`); }
  if (member3_name !== undefined) { params.push(member3_name); fields.push(`member3_name = $${params.length}`); }
  if (protocol_prefix !== undefined) { params.push(protocol_prefix); fields.push(`protocol_prefix = $${params.length}`); }
  if (protocol_next_number !== undefined && protocol_next_number !== '') {
    const n = Number(protocol_next_number);
    if (!Number.isFinite(n) || n < 1) return res.status(400).json({ error: 'invalid_number', message: 'Следующий номер протокола должен быть положительным числом' });
    params.push(Math.round(n)); fields.push(`protocol_next_number = $${params.length}`);
  }
  if (certificate_prefix !== undefined) { params.push(certificate_prefix); fields.push(`certificate_prefix = $${params.length}`); }
  if (certificate_digits !== undefined && certificate_digits !== '') {
    const n = Number(certificate_digits);
    if (!Number.isFinite(n) || n < 1 || n > 10) return res.status(400).json({ error: 'invalid_number', message: 'Количество цифр в номере сертификата должно быть от 1 до 10' });
    params.push(Math.round(n)); fields.push(`certificate_digits = $${params.length}`);
  }
  if (certificate_next_number !== undefined && certificate_next_number !== '') {
    const n = Number(certificate_next_number);
    if (!Number.isFinite(n) || n < 1) return res.status(400).json({ error: 'invalid_number', message: 'Следующий номер сертификата должен быть положительным числом' });
    params.push(Math.round(n)); fields.push(`certificate_next_number = $${params.length}`);
  }
  if (fields.length === 0) return res.json({ ok: true });

  try {
    await query(`UPDATE settings SET ${fields.join(', ')} WHERE id = 1`, params);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Upload logo
router.post('/logo', authRequired, requireRole('superadmin'), uploadLogo.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const p = `/uploads/logo/${req.file.filename}`;
  try {
    await query('UPDATE settings SET logo_path = $1 WHERE id = 1', [p]);
    res.json({ logo_path: p });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Upload stamp
router.post('/stamp', authRequired, requireRole('superadmin'), uploadStamp.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const p = `/uploads/stamp/${req.file.filename}`;
  try {
    await query('UPDATE settings SET stamp_path = $1 WHERE id = 1', [p]);
    res.json({ stamp_path: p });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Upload signature
router.post('/signature', authRequired, requireRole('superadmin'), uploadSignature.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const p = `/uploads/signature/${req.file.filename}`;
  try {
    await query('UPDATE settings SET signature_path = $1 WHERE id = 1', [p]);
    res.json({ signature_path: p });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

module.exports = router;
