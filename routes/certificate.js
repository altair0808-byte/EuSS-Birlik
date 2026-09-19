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

/**
 * Generates a single-page, formal-looking PDF certificate and streams it to `res`.
 * @param {object} res - Express response object (PDF piped directly to it)
 * @param {object} data - { assignment, user, course, settings, lang }
 */
function generateCertificatePdf(res, data) {
  const { assignment, user, course, settings, lang } = data;
  const isKz = lang === 'kz';

  // margin:0 — рамку и всю раскладку считаем сами в абсолютных координатах,
  // чтобы гарантированно не спровоцировать у pdfkit автоматическое добавление
  // второй страницы. Все текстовые блоки ниже ограничены явной шириной и
  // высотой (с ellipsis), поэтому документ всегда остаётся на одном листе.
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0, autoFirstPage: true, bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="certificate_${assignment.certificate_number}.pdf"`);
  doc.pipe(res);

  const hasBold = fs.existsSync(FONT_BOLD);
  const hasReg = fs.existsSync(FONT_REG);
  if (hasReg) doc.registerFont('base', FONT_REG);
  if (hasBold) doc.registerFont('bold', FONT_BOLD);
  const useFont = (name) => { try { doc.font(name === 'bold' && hasBold ? 'bold' : (hasReg ? 'base' : 'Helvetica')); } catch (e) {} };

  const pageWidth = doc.page.width;   // 841.89
  const pageHeight = doc.page.height; // 595.28
  const M = 34; // внешний отступ рамки

  // ---------- Декоративная официальная рамка ----------
  const NAVY = '#12235c';
  const GOLD = '#b8934a';
  const SLATE = '#334155';
  const MUTED = '#64748b';

  doc.save();
  doc.lineWidth(2.4).strokeColor(NAVY).rect(M, M, pageWidth - M * 2, pageHeight - M * 2).stroke();
  doc.lineWidth(0.9).strokeColor(GOLD).rect(M + 7, M + 7, pageWidth - (M + 7) * 2, pageHeight - (M + 7) * 2).stroke();
  doc.lineWidth(0.6).strokeColor('#c7d2fe').rect(M + 12, M + 12, pageWidth - (M + 12) * 2, pageHeight - (M + 12) * 2).stroke();
  doc.restore();

  const innerX = M + 30;
  const innerW = pageWidth - innerX * 2;

  // ---------- Шапка: логотип + название организации ----------
  let headerTop = 46;
  if (settings.logo_path) {
    const logoFile = path.join(__dirname, '..', settings.logo_path.replace(/^\//, ''));
    if (fs.existsSync(logoFile)) {
      try { doc.image(logoFile, pageWidth / 2 - 26, headerTop, { width: 52, height: 52, fit: [52, 52] }); } catch (e) {}
    }
  }
  const afterLogoY = headerTop + (settings.logo_path ? 58 : 0);

  useFont('bold');
  doc.fontSize(12).fillColor(SLATE)
    .text(settings.company_name || '', innerX, afterLogoY, { width: innerW, align: 'center', height: 18, ellipsis: true });

  useFont('bold');
  doc.fontSize(30).fillColor(NAVY)
    .text('СЕРТИФИКАТ', innerX, afterLogoY + 22, { width: innerW, align: 'center', height: 40, characterSpacing: 2 });

  useFont('base');
  doc.fontSize(11).fillColor(GOLD)
    .text(`№ ${assignment.certificate_number || ''}`, innerX, afterLogoY + 60, { width: innerW, align: 'center', height: 16, ellipsis: true });

  // ---------- Тело сертификата ----------
  const bodyTop = afterLogoY + 84;
  useFont('base');
  doc.fontSize(11).fillColor(MUTED)
    .text(isKz ? 'осымен куәландырылады, аты-жөні' : 'настоящим удостоверяется, что',
      innerX, bodyTop, { width: innerW, align: 'center', height: 16 });

  const fullName = `${user.last_name || ''} ${user.first_name || ''}`.trim();
  useFont('bold');
  doc.fontSize(22).fillColor('#0f172a')
    .text(fullName, innerX, bodyTop + 18, { width: innerW, align: 'center', height: 30, ellipsis: true });

  const infoLine = isKz
    ? `Объект: ${user.object || '-'}   |   Бөлім: ${user.department || '-'}   |   Лауазым: ${user.position || '-'}`
    : `Объект: ${user.object || '-'}   |   Отдел: ${user.department || '-'}   |   Должность: ${user.position || '-'}`;
  useFont('base');
  doc.fontSize(10.5).fillColor(SLATE)
    .text(infoLine, innerX, bodyTop + 50, { width: innerW, align: 'center', height: 16, ellipsis: true });

  const courseTitle = isKz ? (course.title_kz || course.title_ru || '') : (course.title_ru || '');
  const bodyText = isKz
    ? `«${courseTitle}» курсы бойынша оқыту мен білім тексеруден сәтті өткенін растайды.`
    : `успешно прошёл(а) обучение и проверку знаний по курсу «${courseTitle}».`;
  useFont('base');
  doc.fontSize(12.5).fillColor('#1e293b')
    .text(bodyText, innerX + 60, bodyTop + 74, { width: innerW - 120, align: 'center', height: 44, ellipsis: true });

  const protocolLine = isKz
    ? `Хаттама № ${assignment.protocol_number || '—'} от ${fmtDate(assignment.protocol_date)}`
    : `Протокол № ${assignment.protocol_number || '—'} от ${fmtDate(assignment.protocol_date)}`;
  useFont('base');
  doc.fontSize(10.5).fillColor(MUTED)
    .text(protocolLine, innerX, bodyTop + 124, { width: innerW, align: 'center', height: 14, ellipsis: true });

  const datesLine = isKz
    ? `Өту күні: ${fmtDate(assignment.test_date)}      Келесі өту күні: ${fmtDate(assignment.next_test_date)}`
    : `Дата прохождения: ${fmtDate(assignment.test_date)}      Дата следующего прохождения: ${fmtDate(assignment.next_test_date)}`;
  useFont('base');
  doc.fontSize(10.5).fillColor(MUTED)
    .text(datesLine, innerX, bodyTop + 142, { width: innerW, align: 'center', height: 14, ellipsis: true });

  // ---------- Блок комиссии: председатель + 2 члена ----------
  const commission = [
    { label: isKz ? 'Комиссия төрағасы' : 'Председатель комиссии', name: settings.chairman_name || '', signature: settings.signature_path, stamp: settings.stamp_path },
    { label: isKz ? 'Комиссия мүшесі' : 'Член комиссии', name: settings.member2_name || '' },
    { label: isKz ? 'Комиссия мүшесі' : 'Член комиссии', name: settings.member3_name || '' }
  ];

  const sigBlockTop = pageHeight - M - 118;
  const colGap = 18;
  const colW = (innerW - colGap * 2) / 3;

  commission.forEach((member, i) => {
    const colX = innerX + i * (colW + colGap);
    const lineY = sigBlockTop + 46;

    // Печать/подпись председателя рисуются над линией его колонки
    if (i === 0) {
      if (member.stamp) {
        const stampFile = path.join(__dirname, '..', member.stamp.replace(/^\//, ''));
        if (fs.existsSync(stampFile)) {
          try { doc.opacity(0.9).image(stampFile, colX + colW - 58, sigBlockTop - 34, { width: 70, height: 70, fit: [70, 70] }); doc.opacity(1); } catch (e) {}
        }
      }
      if (member.signature) {
        const sigFile = path.join(__dirname, '..', member.signature.replace(/^\//, ''));
        if (fs.existsSync(sigFile)) {
          try { doc.image(sigFile, colX + 6, lineY - 30, { width: colW - 20, height: 28, fit: [colW - 20, 28] }); } catch (e) {}
        }
      }
    }

    doc.lineWidth(0.8).strokeColor('#94a3b8')
      .moveTo(colX, lineY).lineTo(colX + colW, lineY).stroke();

    useFont('base');
    doc.fontSize(8.5).fillColor(MUTED)
      .text(member.label, colX, lineY + 4, { width: colW, align: 'center', height: 12, ellipsis: true });

    useFont('bold');
    doc.fontSize(9.5).fillColor('#0f172a')
      .text(member.name, colX, lineY + 16, { width: colW, align: 'center', height: 14, ellipsis: true });
  });

  // ---------- Подвал ----------
  useFont('base');
  doc.fontSize(7.5).fillColor('#94a3b8')
    .text(
      isKz
        ? `Құжат жүйеде автоматты түрде жасалды. Сертификат № ${assignment.certificate_number || ''}`
        : `Документ сформирован автоматически системой. Сертификат № ${assignment.certificate_number || ''}`,
      innerX, pageHeight - M - 18, { width: innerW, align: 'center', height: 12, ellipsis: true }
    );

  doc.end();
}

// Route GET /api/certificates/:id
router.get('/:id', authRequired, async (req, res) => {
  try {
    const aRes = await query('SELECT * FROM assignments WHERE id = $1', [req.params.id]);
    const assignment = aRes.rows[0];
    if (!assignment || !assignment.certificate_number) {
      return res.status(404).send('Сертификат не найден');
    }
    const uRes = await query('SELECT * FROM users WHERE id = $1', [assignment.user_id]);
    const user = uRes.rows[0] || {};
    const cRes = await query('SELECT * FROM courses WHERE id = $1', [assignment.course_id]);
    const course = cRes.rows[0] || {};
    const sRes = await query('SELECT * FROM settings WHERE id = 1');
    const settings = sRes.rows[0] || {};
    const lang = req.query.lang || 'ru';

    generateCertificatePdf(res, { assignment, user, course, settings, lang });
  } catch (err) {
    res.status(500).send('Ошибка генерации сертификата: ' + err.message);
  }
});

router.generateCertificatePdf = generateCertificatePdf;
module.exports = router;
module.exports.generateCertificatePdf = generateCertificatePdf;
