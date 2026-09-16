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

// Update settings
router.put('/', authRequired, requireRole('superadmin'), async (req, res) => {
  const { company_name, chairman_name } = req.body;
  const fields = [];
  const params = [];
  if (company_name !== undefined) { params.push(company_name); fields.push(`company_name = $${params.length}`); }
  if (chairman_name !== undefined) { params.push(chairman_name); fields.push(`chairman_name = $${params.length}`); }
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
