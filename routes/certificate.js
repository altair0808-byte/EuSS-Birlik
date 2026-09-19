import express from 'express';
import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { query } from '../db.js';
import { authenticateToken } from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

function parseBase64Image(dataString) {
  if (!dataString || typeof dataString !== 'string') return null;
  const matches = dataString.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
  if (matches && matches.length === 3) {
    return Buffer.from(matches[2], 'base64');
  }
  return null;
}

router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const assignmentId = req.params.id;

    const sql = `
      SELECT 
        a.*,
        u.first_name, u.last_name, u.middle_name, u.iin, u.organization, u.position,
        c.title as course_title, c.validity_period_years,
        s.company_name, s.bin, s.training_center_name, s.training_center_address, s.license_info,
        s.chairman_name, s.chairman_position, s.chairman_signature_url,
        s.chairman1_name, s.chairman1_position, s.chairman1_signature,
        s.chairman2_name, s.chairman2_position, s.chairman2_signature,
        s.active_chairman,
        s.logo_url, s.stamp_url, s.logo_data, s.stamp_data
      FROM assignments a
      JOIN users u ON a.user_id = u.id
      JOIN courses c ON a.course_id = c.id
      LEFT JOIN settings s ON s.id = 1
      WHERE a.id = $1
    `;
    const result = await query(sql, [assignmentId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Назначение не найдено' });
    }

    const data = result.rows[0];

    if (data.status !== 'passed') {
      return res.status(400).json({ error: 'Сертификат доступен только после успешной сдачи теста' });
    }

    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margin: 40
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=Certificate_${data.certificate_number || assignmentId}.pdf`);

    doc.pipe(res);

    const fontRegular = path.join(__dirname, '../assets/fonts/DejaVuSans.ttf');
    const fontBold = path.join(__dirname, '../assets/fonts/DejaVuSans-Bold.ttf');

    if (fs.existsSync(fontRegular)) {
      doc.registerFont('DejaVu', fontRegular);
      doc.font('DejaVu');
    }
    if (fs.existsSync(fontBold)) {
      doc.registerFont('DejaVu-Bold', fontBold);
    }

    // Рамка документа
    doc.lineWidth(3).strokeColor('#1e3a8a').rect(20, 20, 802, 555).stroke();
    doc.lineWidth(1).strokeColor('#93c5fd').rect(25, 25, 792, 545).stroke();

    // Логотип (увеличенный размер 90x54)
    let logoBuffer = parseBase64Image(data.logo_data);
    if (!logoBuffer && data.logo_url && fs.existsSync(data.logo_url)) {
      logoBuffer = fs.readFileSync(data.logo_url);
    }
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, 50, 40, { width: 90, height: 54, fit: [90, 54] });
      } catch (e) {
        console.error('Ошибка вставки логотипа:', e);
      }
    }

    doc.fontSize(16).fillColor('#1e3a8a');
    if (fs.existsSync(fontBold)) doc.font('DejaVu-Bold');
    doc.text(data.company_name || 'УЧЕБНЫЙ ЦЕНТР', 150, 48, { align: 'center', width: 540 });

    doc.fontSize(9).fillColor('#475569');
    if (fs.existsSync(fontRegular)) doc.font('DejaVu');
    const licenseText = data.license_info ? `Лицензия: ${data.license_info}` : '';
    const binText = data.bin ? `БИН: ${data.bin}` : '';
    doc.text([licenseText, binText].filter(Boolean).join(' | '), 150, 72, { align: 'center', width: 540 });

    doc.moveDown(2);

    doc.fontSize(28).fillColor('#0f172a');
    if (fs.existsSync(fontBold)) doc.font('DejaVu-Bold');
    doc.text('СЕРТИФИКАТ', 0, 125, { align: 'center' });

    doc.fontSize(11).fillColor('#64748b');
    if (fs.existsSync(fontRegular)) doc.font('DejaVu');
    doc.text(`№ ${data.certificate_number || 'б/н'}`, 0, 160, { align: 'center' });

    doc.fontSize(12).fillColor('#334155');
    doc.text('Настоящий сертификат подтверждает, что', 0, 195, { align: 'center' });

    const fullName = [data.last_name, data.first_name, data.middle_name].filter(Boolean).join(' ');
    doc.fontSize(22).fillColor('#1e3a8a');
    if (fs.existsSync(fontBold)) doc.font('DejaVu-Bold');
    doc.text(fullName.toUpperCase(), 0, 222, { align: 'center' });

    doc.fontSize(11).fillColor('#475569');
    if (fs.existsSync(fontRegular)) doc.font('DejaVu');
    const iinLine = data.iin ? `ИИН: ${data.iin}` : '';
    const orgLine = data.organization ? `Организация: ${data.organization}` : '';
    doc.text([iinLine, orgLine].filter(Boolean).join('   •   '), 0, 255, { align: 'center' });

    doc.fontSize(12).fillColor('#334155');
    doc.text('успешно прошел(ла) проверку знаний по курсу:', 0, 285, { align: 'center' });

    doc.fontSize(16).fillColor('#0f172a');
    if (fs.existsSync(fontBold)) doc.font('DejaVu-Bold');
    doc.text(`«${data.course_title}»`, 60, 312, { align: 'center', width: 722 });

    const testDateStr = data.test_date ? new Date(data.test_date).toLocaleDateString('ru-RU') : '—';
    const nextDateStr = data.next_test_date ? new Date(data.next_test_date).toLocaleDateString('ru-RU') : '—';
    const protocolStr = data.protocol_number ? `Протокол № ${data.protocol_number}` : '';

    doc.fontSize(10).fillColor('#475569');
    if (fs.existsSync(fontRegular)) doc.font('DejaVu');
    doc.text(`Дата выдачи: ${testDateStr}        Действителен до: ${nextDateStr}        ${protocolStr}`, 0, 365, { align: 'center' });

    // Блок председателя на вахте (1 или 2 сменщик)
    const isShift2 = parseInt(data.active_chairman, 10) === 2;
    const chairName = isShift2 ? (data.chairman2_name || data.chairman1_name) : (data.chairman1_name || data.chairman_name || 'Председатель комиссии');
    const chairPos = isShift2 ? (data.chairman2_position || 'Председатель комиссии') : (data.chairman1_position || data.chairman_position || 'Председатель комиссии');
    const chairSigData = isShift2 ? (data.chairman2_signature || data.chairman1_signature) : (data.chairman1_signature || data.chairman_signature_url);

    const signBaseY = 430;
    doc.fontSize(10).fillColor('#1e293b');
    if (fs.existsSync(fontBold)) doc.font('DejaVu-Bold');
    doc.text(chairPos, 80, signBaseY);

    if (fs.existsSync(fontRegular)) doc.font('DejaVu');
    doc.text(chairName, 520, signBaseY, { width: 240, align: 'right' });

    doc.moveTo(270, signBaseY + 12).lineTo(510, signBaseY + 12).strokeColor('#cbd5e1').lineWidth(1).stroke();

    // Подпись
    let sigBuffer = parseBase64Image(chairSigData);
    if (!sigBuffer && chairSigData && fs.existsSync(chairSigData)) {
      sigBuffer = fs.readFileSync(chairSigData);
    }
    if (sigBuffer) {
      try {
        doc.image(sigBuffer, 320, signBaseY - 26, { width: 130, height: 42, fit: [130, 42] });
      } catch (e) {
        console.error('Ошибка вставки подписи:', e);
      }
    }

    // Печать (частично накладывается на край подписи)
    let stampBuffer = parseBase64Image(data.stamp_data);
    if (!stampBuffer && data.stamp_url && fs.existsSync(data.stamp_url)) {
      stampBuffer = fs.readFileSync(data.stamp_url);
    }
    if (stampBuffer) {
      try {
        doc.save();
        doc.opacity(0.88);
        doc.image(stampBuffer, 410, signBaseY - 45, { width: 105, height: 105, fit: [105, 105] });
        doc.restore();
      } catch (e) {
        console.error('Ошибка вставки печати:', e);
      }
    }

    doc.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка генерации сертификата' });
  }
});

export default router;
