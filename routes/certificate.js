const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { authRequired } = require('./auth');

const FONT_REG = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans.ttf');
const FONT_BOLD = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans-Bold.ttf');

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return dt.toLocaleDateString('ru-RU');
}

function generateCertificatePdf(res, data) {
  const { assignment, user, course, settings, lang } = data;
  const isKz = lang === 'kz';

  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="certificate_${assignment.certificate_number || assignment.id}.pdf"`);
  doc.pipe(res);

  if (fs.existsSync(FONT_REG)) doc.registerFont('base', FONT_REG);
  if (fs.existsSync(FONT_BOLD)) doc.registerFont('bold', FONT_BOLD);

  const fontBase = fs.existsSync(FONT_REG) ? 'base' : 'Helvetica';
  const fontBold = fs.existsSync(FONT_BOLD) ? 'bold' : 'Helvetica-Bold';

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;

  // Decorative border
  doc.lineWidth(2).strokeColor('#1e3a8a')
    .rect(20, 20, pageWidth - 40, pageHeight - 40).stroke();
  doc.lineWidth(0.75).strokeColor('#93c5fd')
    .rect(28, 28, pageWidth - 56, pageHeight - 56).stroke();

  // Logo
  if (settings && settings.logo_path) {
    const logoFile = path.join(__dirname, '..', settings.logo_path.replace(/^\//, ''));
    if (fs.existsSync(logoFile)) {
      try { doc.image(logoFile, pageWidth / 2 - 40, 40, { width: 80, height: 80, fit: [80, 80] }); } catch (e) {}
    }
  }

  doc.font(fontBold).fontSize(11).fillColor('#334155')
    .text((settings && settings.company_name) || '', 0, 130, { align: 'center' });

  doc.font(fontBold).fontSize(26).fillColor('#1e3a8a')
    .text('СЕРТИФИКАТ', 0, 155, { align: 'center' });

  doc.font(fontBase).fontSize(12).fillColor('#475569')
    .text(`№ ${assignment.certificate_number || '-'}`, 0, 190, { align: 'center' });

  const fullName = `${user.last_name} ${user.first_name}`;
  doc.font(fontBold).fontSize(20).fillColor('#0f172a')
    .text(fullName, 0, 225, { align: 'center' });

  const infoLine = isKz
    ? `Объект/Обьект: ${user.object || '-'}   Бөлім: ${user.department || '-'}   Лауазым: ${user.position || '-'}`
    : `Объект: ${user.object || '-'}   Отдел: ${user.department || '-'}   Должность: ${user.position || '-'}`;
  doc.font(fontBase).fontSize(11).fillColor('#334155')
    .text(infoLine, 0, 255, { align: 'center' });

  const courseTitle = isKz ? (course.title_kz || course.title_ru) : (course.title_ru || course.title_kz);
  const bodyText = isKz
    ? `аталған қызметкердің «${courseTitle}» курсы бойынша оқыту мен білім тексеруден сәтті өткенін растайды.`
    : `подтверждает, что указанный сотрудник успешно прошёл обучение и проверку знаний по курсу «${courseTitle}».`;
  doc.font(fontBase).fontSize(13).fillColor('#1e293b')
    .text(bodyText, 100, 290, { align: 'center', width: pageWidth - 200 });

  const protocolLine = `Протокол № ${assignment.protocol_number} от ${fmtDate(assignment.protocol_date)}`;
  doc.font(fontBase).fontSize(11).fillColor('#475569')
    .text(protocolLine, 0, 340, { align: 'center' });

  const datesLine = isKz
    ? `Өту күні: ${fmtDate(assignment.test_date)}      Келесі өту күні: ${fmtDate(assignment.next_test_date)}`
    : `Дата прохождения: ${fmtDate(assignment.test_date)}      Дата следующего прохождения: ${fmtDate(assignment.next_test_date)}`;
  doc.font(fontBase).fontSize(11).fillColor('#475569')
    .text(datesLine, 0, 360, { align: 'center' });

  // Signature + Stamp block
  const sigY = pageHeight - 140;
  doc.font(fontBase).fontSize(11).fillColor('#0f172a')
    .text(isKz ? 'Комиссия төрағасы:' : 'Председатель комиссии:', 120, sigY);
  doc.font(fontBold).fontSize(11).text((settings && settings.chairman_name) || '', 120, sigY + 16);

  if (settings && settings.signature_path) {
    const sigFile = path.join(__dirname, '..', settings.signature_path.replace(/^\//, ''));
    if (fs.existsSync(sigFile)) {
      try { doc.image(sigFile, 320, sigY - 10, { width: 100, height: 50, fit: [100, 50] }); } catch (e) {}
    }
  }
  if (settings && settings.stamp_path) {
    const stampFile = path.join(__dirname, '..', settings.stamp_path.replace(/^\//, ''));
    if (fs.existsSync(stampFile)) {
      try { doc.image(stampFile, 480, sigY - 30, { width: 110, height: 110, fit: [110, 110], opacity: 0.9 }); } catch (e) {}
    }
  }

  doc.font(fontBase).fontSize(8).fillColor('#94a3b8')
    .text(`Сертификат № ${assignment.certificate_number || '-'}`, 0, pageHeight - 34, { align: 'center' });

  doc.end();
}

// GET /api/certificates/:assignmentId
router.get('/:id', authRequired, (req, res) => {
  const assignment = db.prepare('SELECT * FROM assignments WHERE id = ?').get(req.params.id);
  if (!assignment) return res.status(404).json({ error: 'assignment_not_found' });

  if (req.user.role === 'employee' && assignment.user_id !== req.user.id) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(assignment.user_id);
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(assignment.course_id);
  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get() || {};

  generateCertificatePdf(res, {
    assignment,
    user,
    course,
    settings,
    lang: req.query.lang || 'ru'
  });
});

module.exports = router;
module.exports.generateCertificatePdf = generateCertificatePdf;
