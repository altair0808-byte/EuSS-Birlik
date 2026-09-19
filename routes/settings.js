import express from 'express';
import { query } from '../db.js';
import { authenticateToken, requireSuperAdmin } from '../routes/auth.js';
import { upload } from '../upload.js';
import fs from 'fs';

const router = express.Router();

function fileToBase64(file) {
  if (!file || !file.path) return null;
  try {
    const data = fs.readFileSync(file.path);
    const mime = file.mimetype || 'image/png';
    return `data:${mime};base64,${data.toString('base64')}`;
  } catch (e) {
    console.error('Error reading uploaded file:', e);
    return null;
  }
}

router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await query('SELECT * FROM settings WHERE id = 1');
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Настройки не найдены' });
    }
    const s = result.rows[0];
    res.json({
      ...s,
      logo_url: s.logo_data || s.logo_url,
      stamp_url: s.stamp_data || s.stamp_url,
      chairman1_signature: s.chairman1_signature || s.chairman_signature_url,
      chairman_signature_url: s.chairman1_signature || s.chairman_signature_url
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.put('/', authenticateToken, requireSuperAdmin, upload.fields([
  { name: 'logo', maxCount: 1 },
  { name: 'stamp', maxCount: 1 },
  { name: 'chairman_signature', maxCount: 1 },
  { name: 'chairman1_signature_file', maxCount: 1 },
  { name: 'chairman2_signature_file', maxCount: 1 }
]), async (req, res) => {
  try {
    const current = await query('SELECT * FROM settings WHERE id = 1');
    const existing = current.rows[0] || {};

    const {
      company_name, bin, training_center_name, training_center_address, license_info,
      chairman_name, chairman_position,
      chairman1_name, chairman1_position,
      chairman2_name, chairman2_position,
      active_chairman,
      protocol_prefix, protocol_next_number,
      cert_prefix, cert_next_number
    } = req.body;

    let logo_data = existing.logo_data;
    let stamp_data = existing.stamp_data;
    let chairman1_sig = existing.chairman1_signature || existing.chairman_signature_url;
    let chairman2_sig = existing.chairman2_signature;

    if (req.files && req.files['logo']) {
      logo_data = fileToBase64(req.files['logo'][0]);
    }
    if (req.files && req.files['stamp']) {
      stamp_data = fileToBase64(req.files['stamp'][0]);
    }
    if (req.files && req.files['chairman_signature']) {
      chairman1_sig = fileToBase64(req.files['chairman_signature'][0]);
    }
    if (req.files && req.files['chairman1_signature_file']) {
      chairman1_sig = fileToBase64(req.files['chairman1_signature_file'][0]);
    }
    if (req.files && req.files['chairman2_signature_file']) {
      chairman2_sig = fileToBase64(req.files['chairman2_signature_file'][0]);
    }

    const c1_name = chairman1_name || chairman_name || existing.chairman1_name || existing.chairman_name;
    const c1_pos = chairman1_position || chairman_position || existing.chairman1_position || existing.chairman_position;
    const act_chair = parseInt(active_chairman, 10) === 2 ? 2 : 1;

    const updateQuery = `
      UPDATE settings SET
        company_name = COALESCE($1, company_name),
        bin = COALESCE($2, bin),
        training_center_name = COALESCE($3, training_center_name),
        training_center_address = COALESCE($4, training_center_address),
        license_info = COALESCE($5, license_info),
        chairman_name = $6,
        chairman_position = $7,
        chairman1_name = $6,
        chairman1_position = $7,
        chairman2_name = COALESCE($8, chairman2_name),
        chairman2_position = COALESCE($9, chairman2_position),
        active_chairman = $10,
        logo_data = COALESCE($11, logo_data),
        stamp_data = COALESCE($12, stamp_data),
        chairman1_signature = COALESCE($13, chairman1_signature),
        chairman2_signature = COALESCE($14, chairman2_signature),
        protocol_prefix = COALESCE($15, protocol_prefix),
        protocol_next_number = COALESCE($16, protocol_next_number),
        cert_prefix = COALESCE($17, cert_prefix),
        cert_next_number = COALESCE($18, cert_next_number)
      WHERE id = 1
      RETURNING *;
    `;

    const values = [
      company_name, bin, training_center_name, training_center_address, license_info,
      c1_name, c1_pos,
      chairman2_name, chairman2_position,
      act_chair,
      logo_data, stamp_data, chairman1_sig, chairman2_sig,
      protocol_prefix,
      protocol_next_number ? parseInt(protocol_next_number, 10) : null,
      cert_prefix,
      cert_next_number ? parseInt(cert_next_number, 10) : null
    ];

    const updated = await query(updateQuery, values);
    res.json(updated.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка при сохранении настроек' });
  }
});

export default router;
