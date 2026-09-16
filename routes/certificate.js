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
  return dt.toLocaleDateString('ru-RU');
}

/**
 * Generates a PDF certificate and streams it to `res`.
 * @param {object} res - Express response object (PDF piped directly to it)
 * @param {object} data - { assignment, user, course, settings, lang }
 */
function generateCertificatePdf(res, data) {
  const { assignment, user, course, settings, lang } = data;
  const isKz = lang === 'kz';

  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="certificate_${assignment.certificate_number}.pdf"`);
  doc.pipe(res);

  if (fs.existsSync(FONT_REG)) doc.registerFont('base', FONT_REG);
  if (fs.existsSync(FONT_BOLD)) doc.registerFont('bold', FONT_BOLD);

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;

  // Decorative border
  doc.lineWidth(2).strokeColor('#1e3a8a')
    .rect(20, 20, pageWidth - 40, pageHeight - 40).stroke();
  doc.lineWidth(0.75).strokeColor('#93c5fd')
    .rect(28, 28, pageWidth - 56, pageHeight - 56).stroke();

  // Logo
  if (settings.logo_path) {
    const logoFile = path.join(__dirname, '..', settings.logo_path.replace(/^\//, ''));
    if (fs.existsSync(logoFile)) {
      try { doc.image(logoFile, pageWidth / 2 - 40, 40, { width: 80, height: 80, fit: [80, 80] }); } catch (e) {}
    }
  }

  try { if (fs.existsSync(FONT_BOLD)) doc.font('bold'); } catch (e) {}
  doc.fontSize(11).fillColor('#334155')
    .text(settings.company_name || '', 0, 130, { align: 'center' });

  doc.fontSize(26).fillColor('#1e3a8a')
    .text(isKz ? 'СЕРТИФИКАТ' : 'СЕРТИФИКАТ', 0, 155, { align: 'center' });

  try { if (fs.existsSync(FONT_REG)) doc.font('base'); } catch (e) {}
  doc.fontSize(12).fillColor('#475569')
    .text(isKz ? `№ ${assignment.certificate_number}` : `№ ${assignment.certificate_number}`, 0, 190, { align: 'center' });

  const fullName = `${user.last_name || ''} ${user.first_name || ''}`;
  try { if (fs.existsSync(FONT_BOLD)) doc.font('bold'); } catch (e) {}
  doc.fontSize(20).fillColor('#0f172a')
    .text(fullName, 0, 225, { align: 'center' });

  const infoLine = isKz
    ? `Объект/Обьект: ${user.object || '-'}   Бөлім: ${user.department || '-'}   Лауазым: ${user.position || '-'}`
    : `Объект: ${user.object || '-'}   Отдел: ${user.department || '-'}   Должность: ${user.position || '-'}`;
  try { if (fs.existsSync(FONT_REG)) doc.font('base'); } catch (e) {}
  doc.fontSize(11).fillColor('#334155')
    .text(infoLine, 0, 255, { align: 'center' });

  const courseTitle = isKz ? (course.title_kz || course.title_ru) : course.title_ru;
  const bodyText = isKz
    ? `аталған қызметкердің «${courseTitle}» курсы бойынша оқыту мен білім тексеруден сәтті өткенін растайды.`
    : `подтверждает, что указанный сотрудник успешно прошёл обучение и проверку знаний по курсу «${courseTitle}».`;
  doc.fontSize(13).fillColor('#1e293b')
    .text(bodyText, 100, 290, { align: 'center', width: pageWidth - 200 });

  const protocolLine = isKz
    ? `Хаттама № ${assignment.protocol_number || '—'} от ${fmtDate(assignment.protocol_date)}`
    : `Протокол № ${assignment.protocol_number || '—'} от ${fmtDate(assignment.protocol_date)}`;
  doc.fontSize(11).fillColor('#475569')
    .text(protocolLine, 0, 340, { align: 'center' });

  const datesLine = isKz
    ? `Өту күні: ${fmtDate(assignment.test_date)}      Келесі өту күні: ${fmtDate(assignment.next_test_date)}`
    : `Дата прохождения: ${fmtDate(assignment.test_date)}      Дата следующего прохождения: ${fmtDate(assignment.next_test_date)}`;
  doc.fontSize(11).fillColor('#475569')
    .text(datesLine, 0, 360, { align: 'center' });

  // Signature + Stamp block
  const sigY = pageHeight - 140;
  doc.fontSize(11).fillColor('#0f172a')
    .text(isKz ? 'Комиссия төрағасы:' : 'Председатель комиссии:', 120, sigY, { continued: false });
  try { if (fs.existsSync(FONT_BOLD)) doc.font('bold'); } catch (e) {}
  doc.fontSize(11).text(settings.chairman_name || '', 120, sigY + 16);

  if (settings.signature_path) {
    const sigFile = path.join(__dirname, '..', settings.signature_path.replace(/^\//, ''));
    if (fs.existsSync(sigFile)) {
      try { doc.image(sigFile, 320, sigY - 10, { width: 100, height: 50, fit: [100, 50] }); } catch (e) {}
    }
  }
  if (settings.stamp_path) {
    const stampFile = path.join(__dirname, '..', settings.stamp_path.replace(/^\//, ''));
    if (fs.existsSync(stampFile)) {
      try { doc.image(stampFile, 480, sigY - 30, { width: 110, height: 110, fit: [110, 110], opacity: 0.9 }); } catch (e) {}
    }
  }

  try { if (fs.existsSync(FONT_REG)) doc.font('base'); } catch (e) {}
  doc.fontSize(8).fillColor('#94a3b8')
    .text(isKz ? `Құжат жүйеде автоматты түрде жасалды. Сертификат № ${assignment.certificate_number}`
               : `Документ сформирован автоматически системой. Сертификат № ${assignment.certificate_number}`,
      0, pageHeight - 34, { align: 'center' });

  doc.end();
}

// Route GET /api/certificates/:id
router.get('/:id', async (req, res) => {
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
