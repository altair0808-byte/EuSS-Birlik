const express = require('express');
const router = express.Router();
const fs = require('fs');
const { query } = require('../db');
const { authRequired, requireRole } = require('./auth');
const { makeUploader } = require('../upload');

const uploadLogo = makeUploader('logo');
const uploadStamp = makeUploader('stamp');
const uploadSignature = makeUploader('signature');

function fileToDataUrl(file) {
  if (!file || !file.path) return null;
  const mime = file.mimetype || 'image/png';
  const b64 = fs.readFileSync(file.path).toString('base64');
  return 'data:' + mime + ';base64,' + b64;
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

router.put('/', authRequired, requireRole('superadmin'), async (req, res) => {
  const {
    company_name, chairman_name, member2_name, member3_name,
    chairman1_name, chairman1_position,
    chairman2_name, chairman2_position,
    active_chairman,
    protocol_prefix, protocol_next_number,
    certificate_prefix, certificate_digits, certificate_next_number
  } = req.body;

  try {
    const actChair = parseInt(active_chairman, 10) === 2 ? 2 : 1;
    const cName = (actChair === 2 ? chairman2_name : (chairman1_name || chairman_name)) || '';

    const result = await query(
      `UPDATE settings SET
        company_name = COALESCE($1, company_name),
        chairman_name = COALESCE($2, chairman_name),
        member2_name = COALESCE($3, member2_name),
        member3_name = COALESCE($4, member3_name),
        chairman1_name = COALESCE($5, chairman1_name),
        chairman1_position = COALESCE($6, chairman1_position),
        chairman2_name = COALESCE($7, chairman2_name),
        chairman2_position = COALESCE($8, chairman2_position),
        active_chairman = $9,
        protocol_prefix = COALESCE($10, protocol_prefix),
        protocol_next_number = COALESCE($11, protocol_next_number),
        certificate_prefix = COALESCE($12, certificate_prefix),
        certificate_digits = COALESCE($13, certificate_digits),
        certificate_next_number = COALESCE($14, certificate_next_number)
      WHERE id = 1
      RETURNING *`,
      [
        company_name, cName, member2_name, member3_name,
        chairman1_name || chairman_name, chairman1_position,
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

router.post('/logo', authRequired, requireRole('superadmin'), uploadLogo.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const dataUrl = fileToDataUrl(req.file);
  const webPath = '/uploads/logo/' + req.file.filename;
  try {
    const result = await query(
      'UPDATE settings SET logo_path = $1, logo_data = $2 WHERE id = 1 RETURNING *',
      [webPath, dataUrl]
    );
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

router.post('/stamp', authRequired, requireRole('superadmin'), uploadStamp.single('stamp'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const dataUrl = fileToDataUrl(req.file);
  const webPath = '/uploads/stamp/' + req.file.filename;
  try {
    const result = await query(
      'UPDATE settings SET stamp_path = $1, stamp_data = $2 WHERE id = 1 RETURNING *',
      [webPath, dataUrl]
    );
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

router.post('/signature', authRequired, requireRole('superadmin'), uploadSignature.single('signature'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const dataUrl = fileToDataUrl(req.file);
  const webPath = '/uploads/signature/' + req.file.filename;
  const chairNum = req.query.chairman === '2' ? 2 : 1;
  const colSig = chairNum === 2 ? 'chairman2_signature' : 'chairman1_signature';

  try {
    const result = await query(
      `UPDATE settings SET signature_path = $1, ${colSig} = $2 WHERE id = 1 RETURNING *`,
      [webPath, dataUrl]
    );
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

module.exports = router;
