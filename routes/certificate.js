const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { query } = require('../db');
const { authRequired } = require('./auth');

const FONT_REG = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans.ttf');
const FONT_BOLD = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans-Bold.ttf');

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('ru-RU');
}

function resolveImageBuffer(imgVal) {
  if (!imgVal) return null;
  try {
    if (imgVal.startsWith('data:image')) {
      const idx = imgVal.indexOf('base64,');
      if (idx !== -1) {
        return Buffer.from(imgVal.slice(idx + 7), 'base64');
      }
    }
    const localPath = path.join(__dirname, '..', imgVal.replace(/^\//, ''));
    if (fs.existsSync(localPath)) {
      return fs.readFileSync(localPath);
    }
  } catch (e) {
    console.error('Error resolving image buffer:', e);
  }
  return null;
}

router.get('/:id', authRequired, async (req, res) => {
  const assignmentId = req.params.id;
  try {
    const aRes = await query(
      `SELECT a.*,
              u.last_name, u.first_name, u.position as user_position, u.department, u.object,
              c.title_ru, c.title_kz, c.validity_months
       FROM assignments a
       JOIN users u ON a.user_id = u.id
       JOIN courses c ON a.course_id = c.id
       WHERE a.id = $1`,
      [assignmentId]
    );
    if (aRes.rows.length === 0) {
      return res.status(404).json({ error: 'not_found' });
    }
    const a = aRes.rows[0];

    if (req.user.role === 'employee' && Number(req.user.id) !== Number(a.user_id)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    if (a.status !== 'passed') {
      return res.status(400).json({ error: 'not_passed' });
    }

    const sRes = await query('SELECT * FROM settings WHERE id = 1');
    const s = sRes.rows[0] || {};

    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margins: { top: 30, bottom: 30, left: 35, right: 35 }
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="certificate_${encodeURIComponent(a.certificate_number || a.id)}.pdf"`
    );
    doc.pipe(res);

    if (fs.existsSync(FONT_REG)) doc.registerFont('DejaVu', FONT_REG);
    if (fs.existsSync(FONT_BOLD)) doc.registerFont('DejaVu-Bold', FONT_BOLD);
    const hasFonts = fs.existsSync(FONT_REG);

    const fRegular = (size = 11) => {
      if (hasFonts) doc.font('DejaVu').fontSize(size);
      else doc.fontSize(size);
    };
    const fBold = (size = 11) => {
      if (hasFonts && fs.existsSync(FONT_BOLD)) doc.font('DejaVu-Bold').fontSize(size);
      else doc.fontSize(size);
    };

    // Рамка документа
    doc.rect(20, 20, 802, 555).lineWidth(2).strokeColor('#0f3b6c').stroke();
    doc.rect(25, 25, 792, 545).lineWidth(0.8).strokeColor('#8aa8c8').stroke();

    // Логотип (увеличенный размер)
    const logoBuf = resolveImageBuffer(s.logo_data || s.logo_path);
    if (logoBuf) {
      try {
        doc.image(logoBuf, 50, 40, { width: 90, height: 55, fit: [90, 55] });
      } catch (e) {
        console.error('Ошибка вставки логотипа в PDF:', e);
      }
    }

    fBold(15);
    doc.fillColor('#0f3b6c');
    doc.text(s.company_name || 'ТОО «Компания»', 150, 48, { align: 'center', width: 540 });

    fBold(24);
    doc.fillColor('#1b365d');
    doc.text('СЕРТИФИКАТ / СЕРТИФИКАТЫ', 0, 120, { align: 'center' });

    fBold(12);
    doc.fillColor('#333333');
    doc.text(`№ ${a.certificate_number || '—'}`, 0, 155, { align: 'center' });

    fRegular(11);
    doc.fillColor('#444444');
    doc.text('Настоящим подтверждается, что / Осы арқылы расталады:', 0, 185, { align: 'center' });

    fBold(19);
    doc.fillColor('#000000');
    doc.text(`${a.last_name || ''} ${a.first_name || ''}`.trim(), 0, 210, { align: 'center' });

    fRegular(10.5);
    doc.fillColor('#555555');
    const empDetails = [a.position || a.user_position, a.department, a.object].filter(Boolean).join(' • ');
    if (empDetails) {
      doc.text(empDetails, 0, 238, { align: 'center' });
    }

    fRegular(11);
    doc.fillColor('#444444');
    doc.text('успешно прошел(ла) проверку знаний по курсу / келесі курс бойынша білімін сәтті тексеруден өтті:', 0, 268, { align: 'center' });

    fBold(13.5);
    doc.fillColor('#0f3b6c');
    const courseTitle = a.title_ru || a.title_kz || 'Курс';
    doc.text(`«${courseTitle}»`, 60, 292, { align: 'center', width: 722 });

    fRegular(9.5);
    doc.fillColor('#333333');
    const issueDateStr = fmtDate(a.test_date || a.protocol_date);
    const validUntilStr = fmtDate(a.next_test_date);
    const protStr = a.protocol_number ? `Протокол № ${a.protocol_number}` : '';
    doc.text(`Дата выдачи: ${issueDateStr}     Действителен до: ${validUntilStr}     ${protStr}`, 0, 345, { align: 'center' });

    // Блок председателя (сменщик 1 или 2 на вахте)
    const isShift2 = parseInt(s.active_chairman, 10) === 2;
    const chairName = isShift2 ? (s.chairman2_name || s.chairman1_name) : (s.chairman1_name || s.chairman_name || 'Председатель комиссии');
    const chairPos = isShift2 ? (s.chairman2_position || 'Председатель комиссии') : (s.chairman1_position || 'Председатель комиссии');
    const chairSigData = isShift2 ? (s.chairman2_signature || s.chairman1_signature) : (s.chairman1_signature || s.signature_path);

    const signBaseY = 415;
    fBold(10);
    doc.fillColor('#000000');
    doc.text(chairPos, 80, signBaseY);

    fRegular(10);
    doc.text(chairName, 520, signBaseY, { width: 240, align: 'right' });

    doc.moveTo(270, signBaseY + 12).lineTo(510, signBaseY + 12).strokeColor('#888888').lineWidth(0.8).stroke();

    // Подпись руководителя
    const sigBuf = resolveImageBuffer(chairSigData);
    if (sigBuf) {
      try {
        doc.image(sigBuf, 320, signBaseY - 26, { width: 130, height: 42, fit: [130, 42] });
      } catch (e) {
        console.error('Ошибка вставки подписи:', e);
      }
    }

    // Печать (накладывается частично на подпись)
    const stampBuf = resolveImageBuffer(s.stamp_data || s.stamp_path);
    if (stampBuf) {
      try {
        doc.save();
        doc.opacity(0.88);
        doc.image(stampBuf, 410, signBaseY - 45, { width: 105, height: 105, fit: [105, 105] });
        doc.restore();
      } catch (e) {
        console.error('Ошибка вставки печати:', e);
      }
    }

    doc.end();
  } catch (e) {
    console.error('Certificate generation error:', e);
    if (!res.headersSent) {
      res.status(500).json({ error: 'cert_error', details: e.message });
    }
  }
});

module.exports = router;
