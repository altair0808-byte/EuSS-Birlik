// Роуты удостоверений БиОТ (ЭТАП 1).
//
//   GET  /api/certificates/mine            — список СВОИХ удостоверений (сотрудник)
//   GET  /api/certificates/uid/:uid/pdf    — скачать PDF по внутреннему UID
//   GET  /api/certificates/uid/:uid/docx   — скачать Word по внутреннему UID
//   GET  /api/certificates/verify/:uid     — ПУБЛИЧНО (без авторизации), для QR/страницы проверки
//   GET  /api/certificates/:id             — старая ссылка по id НАЗНАЧЕНИЯ (оставлена для
//                                             совместимости — весь текущий интерфейс уже
//                                             ссылается на неё как на "Скачать сертификат")
const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { authRequired } = require('./auth');
const {
  ensureCertificateForAssignment,
  getCertificateFullByUid,
  getCertificateFullByAssignmentId,
  listMyCertificates,
  getCommitteeSignaturesForProtocol
} = require('../certificateService');
const { buildCertificatePdfBuffer } = require('../certificatePdf');
const { buildCertificateDocx } = require('../certificateDocx');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

function buildVerifyUrl(req, uid) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.get('host');
  return `${proto}://${host}/verify/${encodeURIComponent(uid)}`;
}

async function fetchRemoteBuffer(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (resp) => {
      if (resp.statusCode && resp.statusCode >= 400) { resp.resume(); return reject(new Error('HTTP ' + resp.statusCode)); }
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => resolve(Buffer.concat(chunks)));
      resp.on('error', reject);
    }).on('error', reject);
  });
}

async function resolveImageBuffer(imgVal) {
  if (!imgVal) return null;
  try {
    if (imgVal.startsWith('data:image')) {
      const idx = imgVal.indexOf('base64,');
      if (idx !== -1) return Buffer.from(imgVal.slice(idx + 7), 'base64');
    }
    if (/^https?:\/\//i.test(imgVal)) return await fetchRemoteBuffer(imgVal);
    const localPath = path.join(__dirname, '..', imgVal.replace(/^\//, ''));
    if (fs.existsSync(localPath)) return fs.readFileSync(localPath);
  } catch (e) { console.error('Error resolving image buffer:', e); }
  return null;
}

async function loadSettings() {
  const sRes = await query('SELECT * FROM settings WHERE id = 1');
  return sRes.rows[0] || {};
}

// ---------- Мои удостоверения (сотрудник) ----------
router.get('/mine', authRequired, async (req, res) => {
  try {
    const list = await listMyCertificates(req.user.id);
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// ---------- PDF по UID ----------
router.get('/uid/:uid/pdf', authRequired, async (req, res) => {
  try {
    const cert = await getCertificateFullByUid(req.params.uid);
    if (!cert) return res.status(404).json({ error: 'not_found' });
    if (req.user.role === 'employee' && Number(req.user.id) !== Number(cert.employee_id)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const settings = await loadSettings();
    const verifyUrl = buildVerifyUrl(req, cert.certificate_uid);
    // ЭТАП 2: удостоверение отдельно не подписывается — если оно привязано к протоколу,
    // подписи комиссии берутся живьём из этого протокола (routes/protocols.js:sign).
    const committeeSignatures = await getCommitteeSignaturesForProtocol(cert.protocol_id);
    const buffer = await buildCertificatePdfBuffer(cert, settings, verifyUrl, committeeSignatures);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="certificate_${encodeURIComponent(cert.certificate_number || cert.certificate_uid)}.pdf"`);
    res.send(buffer);
  } catch (e) {
    console.error('Certificate PDF (uid) error:', e);
    if (!res.headersSent) res.status(500).json({ error: 'cert_error', details: e.message });
  }
});

// ---------- DOCX по UID ----------
router.get('/uid/:uid/docx', authRequired, async (req, res) => {
  try {
    const cert = await getCertificateFullByUid(req.params.uid);
    if (!cert) return res.status(404).json({ error: 'not_found' });
    if (req.user.role === 'employee' && Number(req.user.id) !== Number(cert.employee_id)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const settings = await loadSettings();
    const verifyUrl = buildVerifyUrl(req, cert.certificate_uid);
    const [logoBuf, stampBuf, sig1Buf, sig2Buf] = await Promise.all([
      resolveImageBuffer(settings.logo_data || settings.logo_path),
      resolveImageBuffer(settings.stamp_data || settings.stamp_path),
      resolveImageBuffer(settings.chairman1_signature),
      resolveImageBuffer(settings.chairman2_signature)
    ]);
    const QRCode = require('qrcode');
    const qrBuf = await QRCode.toBuffer(verifyUrl, { type: 'png', margin: 1, width: 220 }).catch(() => null);
    const committeeSignatures = await getCommitteeSignaturesForProtocol(cert.protocol_id);

    const { buffer, fileName } = await buildCertificateDocx(cert, settings, verifyUrl, {
      logoBuf, stampBuf, sig1Buf, sig2Buf, qrBuf
    }, committeeSignatures);

    const asciiName = `certificate_${String(cert.certificate_number || cert.certificate_uid).replace(/[^A-Za-z0-9_-]/g, '')}.docx`;
    const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encoded}`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(buffer);
  } catch (e) {
    console.error('Certificate DOCX (uid) error:', e);
    if (!res.headersSent) res.status(500).json({ error: 'docx_error', details: e.message });
  }
});

// ---------- Публичная проверка подлинности (страница /verify/:uid, без авторизации) ----------
router.get('/verify/:uid', async (req, res) => {
  try {
    const cert = await getCertificateFullByUid(req.params.uid);
    if (!cert) return res.status(404).json({ found: false });
    res.json({
      found: true,
      status: cert.status,
      certificate_number: cert.certificate_number,
      certificate_uid: cert.certificate_uid,
      full_name: `${cert.last_name || ''} ${cert.first_name || ''}`.trim(),
      course_title_ru: cert.title_ru,
      course_title_kz: cert.title_kz,
      protocol_number: cert.protocol_number,
      issue_date: cert.issue_date,
      expiry_date: cert.expiry_date
    });
  } catch (e) {
    console.error('Certificate verify error:', e);
    res.status(500).json({ found: false, error: 'server_error' });
  }
});

// ---------- Старая ссылка (по id назначения) — оставлена для совместимости с интерфейсом ----------
router.get('/:id', authRequired, async (req, res) => {
  const assignmentId = req.params.id;
  try {
    const aRes = await query('SELECT user_id, status FROM assignments WHERE id = $1', [assignmentId]);
    const a = aRes.rows[0];
    if (!a) return res.status(404).json({ error: 'not_found' });
    if (req.user.role === 'employee' && Number(req.user.id) !== Number(a.user_id)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    if (a.status !== 'passed') return res.status(400).json({ error: 'not_passed' });

    await ensureCertificateForAssignment(assignmentId);
    const cert = await getCertificateFullByAssignmentId(assignmentId);
    if (!cert) return res.status(404).json({ error: 'not_found' });

    const settings = await loadSettings();
    const verifyUrl = buildVerifyUrl(req, cert.certificate_uid);
    const committeeSignatures = await getCommitteeSignaturesForProtocol(cert.protocol_id);
    const buffer = await buildCertificatePdfBuffer(cert, settings, verifyUrl, committeeSignatures);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="certificate_${encodeURIComponent(cert.certificate_number || cert.id)}.pdf"`);
    res.send(buffer);
  } catch (e) {
    console.error('Certificate generation error:', e);
    if (!res.headersSent) res.status(500).json({ error: 'cert_error', details: e.message });
  }
});

module.exports = router;
