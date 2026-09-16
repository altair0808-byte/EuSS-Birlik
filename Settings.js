const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { makeUploader } = require('../utils/upload');

const router = express.Router();
const uploadLogo = makeUploader('logo');
const uploadStamp = makeUploader('stamp');
const uploadSignature = makeUploader('signature');

router.get('/', authRequired, (req, res) => {
  const row = db.prepare('SELECT * FROM settings WHERE id = 1').get();
  res.json(row);
});

router.put('/', authRequired, requireRole('superadmin'), (req, res) => {
  const { company_name, chairman_name } = req.body;
  const fields = [];
  const params = [];
  if (company_name !== undefined) { fields.push('company_name = ?'); params.push(company_name); }
  if (chairman_name !== undefined) { fields.push('chairman_name = ?'); params.push(chairman_name); }
  if (fields.length) {
    db.prepare(`UPDATE settings SET ${fields.join(', ')} WHERE id = 1`).run(...params);
  }
  res.json({ ok: true });
});

router.post('/logo', authRequired, requireRole('superadmin'), uploadLogo.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  db.prepare('UPDATE settings SET logo_path = ? WHERE id = 1').run(`/uploads/logo/${req.file.filename}`);
  res.json({ ok: true, path: `/uploads/logo/${req.file.filename}` });
});

router.post('/stamp', authRequired, requireRole('superadmin'), uploadStamp.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  db.prepare('UPDATE settings SET stamp_path = ? WHERE id = 1').run(`/uploads/stamp/${req.file.filename}`);
  res.json({ ok: true, path: `/uploads/stamp/${req.file.filename}` });
});

router.post('/signature', authRequired, requireRole('superadmin'), uploadSignature.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  db.prepare('UPDATE settings SET signature_path = ? WHERE id = 1').run(`/uploads/signature/${req.file.filename}`);
  res.json({ ok: true, path: `/uploads/signature/${req.file.filename}` });
});

module.exports = router;
