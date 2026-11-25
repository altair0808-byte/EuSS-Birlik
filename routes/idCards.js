// Роуты УДОСТОВЕРЕНИЙ (отдельно от сертификатов — routes/certificate.js).
//
//   GET  /api/id-cards/mine             — свои удостоверения (сотрудник)
//   GET  /api/id-cards/me               — МОЙ общий QR + список моих удостоверений с цветом (сотрудник)
//   GET  /api/id-cards/uid/:uid/pdf     — PDF по UID удостоверения
//   GET  /api/id-cards/uid/:uid/docx    — Word по UID удостоверения
//   GET  /api/id-cards/verify/:uid      — ПУБЛИЧНО, для QR / страницы проверки
//   GET  /api/id-cards/:id              — по id НАЗНАЧЕНИЯ (кнопка «Удостоверение» в интерфейсе)
const express = require('express');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
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
const { getPersonForCard, toPublicPayload } = require('../personService');
const { buildIdCardPdfBuffer } = require('../idCardPdf');
const { buildIdCardDocx } = require('../idCardDocx');

function buildVerifyUrl(req, uid) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${req.get('host')}/verify/${encodeURIComponent(uid)}`;
}

// Адрес личной страницы, зашитый в общий QR (один на сотрудника, на всех его удостоверениях).
// PUBLIC_BASE_URL (если задан) важнее заголовка Host: QR на бумаге постоянный, и адрес в нём
// не должен зависеть от того, с какого хоста админ нажал «скачать».
function buildPersonUrl(req, publicUid) {
  const base = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (base) return `${base}/p/${encodeURIComponent(publicUid)}`;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${req.get('host')}/p/${encodeURIComponent(publicUid)}`;
}

// Что зашить в QR удостоверения: общая страница сотрудника /p/<public_uid>, как только она
// есть на сервере (person.html, этап 7); до этого — прежняя проверка по /verify/<UD-…>,
// чтобы QR на выданных бланках никогда не вёл в пустоту.
function qrUrlForCard(req, card) {
  const hasPersonPage = fs.existsSync(path.join(__dirname, '..', 'person.html'));
  return (hasPersonPage && card.public_uid) ? buildPersonUrl(req, card.public_uid) : buildVerifyUrl(req, card.card_uid);
}

// Протокол ещё не подписан председателем — понятный ответ вместо 500 (текст покажет интерфейс).
function sendCardError(res, e, fallback) {
  if (e && e.code === 'protocol_not_signed') return res.status(409).json({ error: 'protocol_not_signed', message: e.message });
  if (!res.headersSent) res.status(500).json({ error: fallback, details: e.message });
  return null;
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

// Сотрудник определяется ТОЛЬКО по токену (req.user.id), никаких id в параметрах.
// Роут объявлен до '/:id', иначе 'me' был бы принят за id назначения.
router.get('/me', authRequired, async (req, res) => {
  try {
    const person = await getPersonForCard(req.user.id);
    if (!person) return res.status(404).json({ error: 'not_found' });
    const url = buildPersonUrl(req, person.user.public_uid);
    const qr_svg = await QRCode.toString(url, {
      type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0b2c5a', light: '#ffffff' }
    });
    const pub = toPublicPayload(person, person.employer);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      public_uid: person.user.public_uid,
      hire_date: person.user.hire_date || null,
      url,
      qr_svg,
      overall_status: person.overall_status,
      courses_count: person.cards.length,
      // courses — как на публичной странице; assignment_id/card_uid нужны кнопкам «Скачать» (авторизованный вид)
      courses: pub.courses.map((c, i) => ({
        ...c,
        assignment_id: person.cards[i].assignment_id,
        card_uid: person.cards[i].card_uid
      }))
    });
  } catch (e) {
    console.error('ID card (me) error:', e);
    if (!res.headersSent) res.status(500).json({ error: 'id_card_error', details: e.message });
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
    const sigs = card.is_external ? null : await getCommitteeSignaturesForProtocol(card.protocol_id);
    const buffer = await buildIdCardPdfBuffer(card, settings, qrUrlForCard(req, card), sigs);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="id_card_${encodeURIComponent(card.card_number || card.card_uid)}.pdf"`);
    res.send(buffer);
  } catch (e) {
    console.error('ID card PDF (uid) error:', e);
    sendCardError(res, e, 'id_card_error');
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
    const sigs = card.is_external ? null : await getCommitteeSignaturesForProtocol(card.protocol_id);
    const { buffer, fileName } = await buildIdCardDocx(card, settings, qrUrlForCard(req, card), sigs);
    const asciiName = `id_card_${String(card.card_number || card.card_uid).replace(/[^A-Za-z0-9_-]/g, '')}.docx`;
    const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encoded}`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(buffer);
  } catch (e) {
    console.error('ID card DOCX (uid) error:', e);
    sendCardError(res, e, 'docx_error');
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
      is_external: !!card.is_external,
      issue_date: card.issue_date,
      expiry_date: card.expiry_date
    });
  } catch (e) {
    console.error('ID card verify error:', e);
    res.status(500).json({ found: false, error: 'server_error' });
  }
});

// По id назначения — как «Скачать сертификат», только удостоверение
// POST /api/id-cards/qr-sheet  { user_ids: [...] } — PDF A4 с QR-карточками сотрудников (8 на лист, с линиями
// для резки). QR ведёт на /p/<public_uid>: там всегда актуальные обучения, санкнижка, медосмотр и
// не пройденные обязательные курсы. Доступно админам, ассистентам (руководителям отделов — только своя зона).
router.post('/qr-sheet', authRequired, async (req, res) => {
  try {
    if (!['superadmin', 'admin', 'assistant'].includes(req.user.role)) return res.status(403).json({ error: 'forbidden' });
    const ids = [...new Set(((req.body && req.body.user_ids) || []).map(Number).filter(Boolean))].slice(0, 2000);
    if (!ids.length) return res.status(400).json({ error: 'no_users', message: 'Выберите сотрудников' });
    const r = await query(`
      SELECT id, last_name, first_name, position, department, object, public_uid, login
      FROM users WHERE id = ANY($1::bigint[]) AND role = 'employee' AND public_uid IS NOT NULL
      ORDER BY department NULLS LAST, last_name, first_name`, [ids]);
    let rows = r.rows;
    if (req.user.role === 'assistant') {
      const zo = Array.isArray(req.user.assistant_objects) ? req.user.assistant_objects : [];
      const zd = Array.isArray(req.user.assistant_departments) ? req.user.assistant_departments : [];
      rows = (!zo.length && !zd.length) ? [] : rows.filter(u => (!zo.length || zo.includes(u.object)) && (!zd.length || zd.includes(u.department)));
    }
    if (!rows.length) return res.status(404).json({ error: 'not_found', message: 'Нет сотрудников для QR (вне зоны доступа или не найдены)' });
    const employer = ((await query('SELECT company_name FROM settings WHERE id = 1')).rows[0] || {}).company_name || '';

    const PDFDocument = require('pdfkit');
    const FONT_REG = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans.ttf');
    const FONT_BOLD = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans-Bold.ttf');
    const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: 'QR-коды сотрудников' } });
    const reg = fs.existsSync(FONT_REG) ? (doc.registerFont('R', FONT_REG), 'R') : 'Helvetica';
    const bold = fs.existsSync(FONT_BOLD) ? (doc.registerFont('B', FONT_BOLD), 'B') : 'Helvetica-Bold';
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    const done = new Promise(ok => doc.on('end', ok));

    const PW = 595.28, PH = 841.89, M = 22, COLS = 2, ROWS = 4;
    const CW = (PW - 2 * M) / COLS, CH = (PH - 2 * M) / ROWS;
    const QR = 118;
    for (let i = 0; i < rows.length; i++) {
      const u = rows[i];
      const slot = i % (COLS * ROWS);
      if (i > 0 && slot === 0) doc.addPage();
      if (slot === 0) {
        // линии для резки
        doc.save().lineWidth(0.4).strokeColor('#b6c2cf').dash(3, { space: 3 });
        for (let c = 0; c <= COLS; c++) doc.moveTo(M + c * CW, M).lineTo(M + c * CW, PH - M).stroke();
        for (let rr = 0; rr <= ROWS; rr++) doc.moveTo(M, M + rr * CH).lineTo(PW - M, M + rr * CH).stroke();
        doc.restore().undash();
      }
      const x = M + (slot % COLS) * CW, y = M + Math.floor(slot / COLS) * CH;
      const pad = 12;
      // шапка
      doc.save().rect(x + 0.5, y + 0.5, CW - 1, 22).fill('#0f3b6c').restore();
      doc.font(bold).fontSize(8).fillColor('#ffffff')
        .text((employer || 'Обучение по БиОТ').toUpperCase(), x + pad, y + 7, { width: CW - 2 * pad, height: 10, ellipsis: true, lineBreak: false });
      // QR
      const url = buildPersonUrl(req, u.public_uid);
      const png = await QRCode.toBuffer(url, { type: 'png', margin: 0, width: 400, errorCorrectionLevel: 'M' });
      const qx = x + CW - pad - QR, qy = y + 32;
      doc.image(png, qx, qy, { width: QR, height: QR });
      // текст слева
      const tw = CW - 3 * pad - QR;
      let ty = y + 34;
      doc.font(bold).fontSize(12.5).fillColor('#0f172a');
      const name = `${u.last_name || ''} ${u.first_name || ''}`.trim();
      doc.text(name, x + pad, ty, { width: tw, height: 32, ellipsis: true });
      ty = Math.min(doc.y, y + 34 + 32) + 4;
      const line = (label, val) => {
        if (!val) return;
        doc.font(reg).fontSize(6.5).fillColor('#64748b').text(label, x + pad, ty, { width: tw, lineBreak: false });
        ty += 8;
        doc.font(bold).fontSize(8.5).fillColor('#1e293b').text(val, x + pad, ty, { width: tw, height: 20, ellipsis: true });
        ty = Math.min(doc.y, ty + 20) + 3;
      };
      line('Должность / Лауазымы', u.position);
      line('Отдел / Бөлім', u.department || u.object);
      line('Логин / № удостоверения', u.login);
      // подпись под QR
      doc.font(bold).fontSize(7).fillColor('#0f3b6c')
        .text('Сканируйте: обучения, санкнижка, медосмотр', x + pad, y + CH - 30, { width: CW - 2 * pad, align: 'center', lineBreak: false });
      doc.font(reg).fontSize(6.3).fillColor('#64748b')
        .text('Сканерлеңіз: оқытулар, санкітапша, медтексеру · Scan: trainings, medical', x + pad, y + CH - 19, { width: CW - 2 * pad, align: 'center', lineBreak: false });
    }
    doc.end();
    await done;
    const buf = Buffer.concat(chunks);
    try {
      await require('../lib/audit').logAction(req, 'qr_sheet_downloaded', { entityType: 'user', entityName: `${rows.length} сотр.`, details: { count: rows.length } });
    } catch (e) { /* журнал не обязателен */ }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="qr-sotrudniki-${new Date().toISOString().slice(0, 10)}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) {
    console.error('qr-sheet:', e);
    if (!res.headersSent) res.status(500).json({ error: 'server_error', details: e.message });
  }
});

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
    const sigs = card.is_external ? null : await getCommitteeSignaturesForProtocol(card.protocol_id);
    const buffer = await buildIdCardPdfBuffer(card, settings, qrUrlForCard(req, card), sigs);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="id_card_${encodeURIComponent(card.card_number || card.id)}.pdf"`);
    res.send(buffer);
  } catch (e) {
    console.error('ID card generation error:', e);
    sendCardError(res, e, 'id_card_error');
  }
});

module.exports = router;
module.exports.buildPersonUrl = buildPersonUrl;
