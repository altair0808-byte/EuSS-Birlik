// Роуты УДОСТОВЕРЕНИЙ (отдельно от сертификатов — routes/certificate.js).
//
//   GET  /api/id-cards/mine             — свои удостоверения (сотрудник)
//   GET  /api/id-cards/uid/:uid/pdf     — PDF по UID удостоверения
//   GET  /api/id-cards/uid/:uid/docx    — Word по UID удостоверения
//   GET  /api/id-cards/verify/:uid      — ПУБЛИЧНО, для QR / страницы проверки
//   GET  /api/id-cards/:id              — по id НАЗНАЧЕНИЯ (кнопка «Удостоверение» в интерфейсе)
const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { authRequired } = require('./auth');
const {
  ensureIdCardForAssignment,
  getIdCardFullByUid,
  getIdCardFullByAssignmentId,
  listMyIdCards
} = require('../idCardService');
const { getCommitteeSignaturesForProtocol } = require('../certificateService');
const { buildIdCardPdfBuffer } = require('../idCardPdf');
const { buildIdCardDocx } = require('../idCardDocx');

function buildVerifyUrl(req, uid) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${req.get('host')}/verify/${encodeURIComponent(uid)}`;
}

async function loadSettings() {
  const sRes = await query('SELECT * FROM settings WHERE id = 1');
  return sRes.rows[0] || {};
}

router.get('/mine', authRequired, async (req, res) => {
  try {
    res.json(await listMyIdCards(req.user.id));
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

router.get('/uid/:uid/pdf', authRequired, async (req, res) => {
  try {
    const card = await getIdCardFullByUid(req.params.uid);
    if (!card) return res.status(404).json({ error: 'not_found' });
    if (req.user.role === 'employee' && Number(req.user.id) !== Number(card.employee_id)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const settings = await loadSettings();
    const sigs = await getCommitteeSignaturesForProtocol(card.protocol_id);
    const buffer = await buildIdCardPdfBuffer(card, settings, buildVerifyUrl(req, card.card_uid), sigs);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="id_card_${encodeURIComponent(card.card_number || card.card_uid)}.pdf"`);
    res.send(buffer);
  } catch (e) {
    console.error('ID card PDF (uid) error:', e);
    if (!res.headersSent) res.status(500).json({ error: 'id_card_error', details: e.message });
  }
});

router.get('/uid/:uid/docx', authRequired, async (req, res) => {
  try {
    const card = await getIdCardFullByUid(req.params.uid);
    if (!card) return res.status(404).json({ error: 'not_found' });
    if (req.user.role === 'employee' && Number(req.user.id) !== Number(card.employee_id)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const settings = await loadSettings();
    const sigs = await getCommitteeSignaturesForProtocol(card.protocol_id);
    const { buffer, fileName } = await buildIdCardDocx(card, settings, buildVerifyUrl(req, card.card_uid), sigs);
    const asciiName = `id_card_${String(card.card_number || card.card_uid).replace(/[^A-Za-z0-9_-]/g, '')}.docx`;
    const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encoded}`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(buffer);
  } catch (e) {
    console.error('ID card DOCX (uid) error:', e);
    if (!res.headersSent) res.status(500).json({ error: 'docx_error', details: e.message });
  }
});

// Публичная проверка удостоверения (без авторизации) — страница /verify/:uid
router.get('/verify/:uid', async (req, res) => {
  try {
    const card = await getIdCardFullByUid(req.params.uid);
    if (!card) return res.status(404).json({ found: false });
    res.json({
      found: true,
      document_type: 'id_card',
      status: card.status,
      card_number: card.card_number,
      certificate_number: card.card_number,
      certificate_uid: card.card_uid,
      card_uid: card.card_uid,
      full_name: `${card.last_name || ''} ${card.first_name || ''}`.trim(),
      course_title_ru: card.title_ru,
      course_title_kz: card.title_kz,
      protocol_number: card.protocol_number,
      issue_date: card.issue_date,
      expiry_date: card.expiry_date
    });
  } catch (e) {
    console.error('ID card verify error:', e);
    res.status(500).json({ found: false, error: 'server_error' });
  }
});

// По id назначения — как «Скачать сертификат», только удостоверение
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

    await ensureIdCardForAssignment(assignmentId);
    const card = await getIdCardFullByAssignmentId(assignmentId);
    if (!card) return res.status(404).json({ error: 'not_found' });

    const settings = await loadSettings();
    const sigs = await getCommitteeSignaturesForProtocol(card.protocol_id);
    const buffer = await buildIdCardPdfBuffer(card, settings, buildVerifyUrl(req, card.card_uid), sigs);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="id_card_${encodeURIComponent(card.card_number || card.id)}.pdf"`);
    res.send(buffer);
  } catch (e) {
    console.error('ID card generation error:', e);
    if (!res.headersSent) res.status(500).json({ error: 'id_card_error', details: e.message });
  }
});

module.exports = router;
