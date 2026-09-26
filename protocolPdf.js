// PDF-версия протокола комиссии — ТЗ «роли/ИИН/PDF=копия Word» §7: должна выглядеть
// ТОЧНО так же, как Word-бланк (templates/protocol_template.docx), а не как отдельно
// свёрстанная через pdfkit версия. Подход: берём ровно тот же буфер .docx, что отдаёт
// buildProtocolDocx() (routes/protocols.js: GET /:id/download), конвертируем его в PDF
// через LibreOffice headless (сохраняет вёрстку практически 1:1) и поверх результата
// дорисовываем через pdf-lib отдельную страницу со статусом подписания и подписями —
// этого блока в самом Word-шаблоне нет и не будет.
//
// Если LibreOffice недоступен в окружении (переменная SOFFICE_PATH не задана и
// soffice/libreoffice не нашлись в PATH) — используем запасной вариант: старую
// самостоятельно свёрстанную через pdfkit версию (buildProtocolPdfDrawn ниже), чтобы
// скачивание PDF не ломалось совсем, только предупреждаем в логах.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const PDFDocument = require('pdfkit');
const { PDFDocument: PDFLibDocument, rgb, StandardFonts } = require('pdf-lib');
const { buildEmployeeRows, buildProtocolDocx } = require('./protocolDocx');
const { COMMITTEE_ROLES, COMMITTEE_ROLE_LABELS } = require('./lib/committeeRoles');

const FONT_REG = path.join(__dirname, 'assets', 'fonts', 'DejaVuSans.ttf');
const FONT_BOLD = path.join(__dirname, 'assets', 'fonts', 'DejaVuSans-Bold.ttf');

function fmtDateTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDate(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(dateStr || '');
  return `${m[3]}.${m[2]}.${m[1]}`;
}

// Подпись приходит с фронтенда как data:image/png;base64,... (см. index.html, saveMySignature)
function sigImageBuffer(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) return null;
  const idx = dataUrl.indexOf('base64,');
  if (idx === -1) return null;
  try { return Buffer.from(dataUrl.slice(idx + 7), 'base64'); } catch (e) { return null; }
}

// protocol: { protocol_number, open_date, close_date, created_at, fully_signed_at, pdf_version }
// members: строки БД, как для buildProtocolDocx (buildEmployeeRows схлопывает их по сотруднику)
// signatures: [{ committee_role, signed_at, last_name, first_name, position, signature_data }]
// companyName: settings.company_name
function buildProtocolPdfDrawn({ protocol, members, signatures, companyName }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margins: { top: 36, bottom: 36, left: 40, right: 40 } });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const hasFonts = fs.existsSync(FONT_REG);
      const hasBoldFont = fs.existsSync(FONT_BOLD);
      if (hasFonts) doc.registerFont('DejaVu', FONT_REG);
      if (hasBoldFont) doc.registerFont('DejaVu-Bold', FONT_BOLD);
      const fReg = (s = 10) => { if (hasFonts) doc.font('DejaVu'); doc.fontSize(s); };
      const fBold = (s = 10) => { if (hasBoldFont) doc.font('DejaVu-Bold'); else if (hasFonts) doc.font('DejaVu'); doc.fontSize(s); };

      const PAGE_LEFT = 40;
      const PAGE_W = 595.28 - 40 - 40; // A4 портрет минус поля

      fBold(13); doc.fillColor('#0f3b6c');
      doc.text(companyName || 'ТОО «Компания»', { align: 'center' });
      doc.moveDown(0.15);
      fBold(15); doc.fillColor('#1b365d');
      doc.text(`ПРОТОКОЛ № ${protocol.protocol_number}`, { align: 'center' });
      fReg(9.5); doc.fillColor('#555555');
      doc.text(`Заседания комиссии по проверке знаний за период ${fmtDate(protocol.open_date)} — ${fmtDate(protocol.close_date)}`, { align: 'center' });
      doc.moveDown(0.7);

      // ===== Статус подписания (п.7 запроса) =====
      const sigByRole = Object.fromEntries((signatures || []).map(s => [s.committee_role, s]));
      const allSigned = COMMITTEE_ROLES.every(r => sigByRole[r]);

      fBold(10); doc.fillColor('#000000');
      doc.text('Статус подписания:');
      doc.moveDown(0.15);
      COMMITTEE_ROLES.forEach((role) => {
        const s = sigByRole[role];
        fReg(9.3);
        doc.fillColor(s ? '#0a7a3d' : '#a15c00');
        const mark = s ? 'Подписан' : 'Ожидает подписи';
        const who = s ? `— ${(s.last_name || '')} ${(s.first_name || '')}`.trim() + (s.signed_at ? `, ${fmtDateTime(s.signed_at)}` : '') : '';
        doc.text(`   ${COMMITTEE_ROLE_LABELS[role]}: ${mark}  ${who}`);
      });
      doc.moveDown(0.1);
      fBold(9.5);
      doc.fillColor(allSigned ? '#0a7a3d' : '#a15c00');
      doc.text(`Общий статус: ${allSigned ? 'Полностью подписан' : 'Частично подписан'}`);
      doc.moveDown(0.7);
      doc.fillColor('#000000');

      // ===== Таблица сотрудников протокола =====
      const employees = buildEmployeeRows(members);
      const cols = [
        { key: 'n', label: '№', w: 24 },
        { key: 'fio', label: 'ФИО', w: 140 },
        { key: 'pos', label: 'Должность', w: 116 },
        { key: 'dept', label: 'Отдел / объект', w: 95 },
        { key: 'mark', label: 'Результат', w: PAGE_W - (24 + 140 + 116 + 95) }
      ];
      const rowH = 16;
      let y = doc.y;

      const drawHeaderRow = () => {
        fBold(8.3); doc.fillColor('#ffffff');
        doc.rect(PAGE_LEFT, y, PAGE_W, rowH).fill('#334155');
        doc.fillColor('#ffffff');
        let cx = PAGE_LEFT;
        cols.forEach(c => { doc.text(c.label, cx + 3, y + 4, { width: c.w - 6 }); cx += c.w; });
        y += rowH;
      };
      drawHeaderRow();

      fReg(8.1); doc.fillColor('#000000');
      employees.forEach((e, i) => {
        if (y > 760) {
          doc.addPage();
          y = 40;
          drawHeaderRow();
          fReg(8.1); doc.fillColor('#000000');
        }
        if (i % 2 === 1) doc.rect(PAGE_LEFT, y, PAGE_W, rowH).fill('#f1f5f9');
        doc.fillColor('#000000');
        let cx = PAGE_LEFT;
        cols.forEach(c => {
          doc.text(String(e[c.key] ?? ''), cx + 3, y + 4, { width: c.w - 6, height: rowH - 2, ellipsis: true });
          cx += c.w;
        });
        y += rowH;
      });
      doc.y = y + 14;

      // ===== Блок подписей комиссии =====
      if (doc.y > 660) doc.addPage();
      fBold(10.5); doc.fillColor('#000000');
      doc.text('Подписи комиссии');
      doc.moveDown(0.35);

      const colW = PAGE_W / 3;
      const startY = doc.y;
      let maxBottom = startY;
      COMMITTEE_ROLES.forEach((role, i) => {
        const colX = PAGE_LEFT + i * colW;
        const s = sigByRole[role];
        fReg(8.4); doc.fillColor('#444444');
        doc.text(COMMITTEE_ROLE_LABELS[role], colX, startY, { width: colW - 10, align: 'center' });

        const sigTop = startY + 16;
        if (s && s.signature_data) {
          const buf = sigImageBuffer(s.signature_data);
          if (buf) {
            try { doc.image(buf, colX + colW / 2 - 55, sigTop, { fit: [110, 40] }); } catch (e) { /* пропускаем битую картинку подписи */ }
          }
        }
        const lineY = sigTop + 46;
        doc.moveTo(colX + 10, lineY).lineTo(colX + colW - 20, lineY).strokeColor('#999999').lineWidth(0.7).stroke();

        fReg(8.2); doc.fillColor('#000000');
        const name = s ? `${s.last_name || ''} ${s.first_name || ''}`.trim() : '—';
        doc.text(name || '—', colX, lineY + 4, { width: colW - 10, align: 'center' });
        if (s && s.position) {
          fReg(7.3); doc.fillColor('#666666');
          doc.text(s.position, colX, lineY + 15, { width: colW - 10, align: 'center' });
        }
        if (s && s.signed_at) {
          fReg(7.3); doc.fillColor('#666666');
          doc.text(fmtDateTime(s.signed_at), colX, lineY + 26, { width: colW - 10, align: 'center' });
        }
        maxBottom = Math.max(maxBottom, lineY + 38);
      });
      doc.y = maxBottom + 12;
      doc.fillColor('#000000');

      // ===== Служебная информация (п.6 запроса) =====
      fReg(7.4); doc.fillColor('#888888');
      const createdStr = fmtDate(protocol.created_at ? String(protocol.created_at).slice(0, 10) : protocol.open_date);
      let footer = `Версия протокола: ${protocol.pdf_version || 1}    Дата создания: ${createdStr}`;
      if (protocol.fully_signed_at) footer += `    Дата последнего подписания: ${fmtDateTime(protocol.fully_signed_at)}`;
      doc.text(footer, PAGE_LEFT, doc.y, { width: PAGE_W, align: 'center' });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ===================== Новый путь: docx → LibreOffice → PDF + оверлей pdf-lib =====================

// Конвертирует буфер .docx в буфер .pdf через `soffice --headless --convert-to pdf`.
// Путь к бинарнику можно переопределить переменной окружения SOFFICE_PATH (например,
// если в проде soffice лежит не в PATH). Бросает исключение, если конвертация не удалась —
// вызывающий код (buildProtocolPdf) ловит её и уходит на запасной pdfkit-вариант.
function convertDocxToPdf(docxBuffer) {
  return new Promise((resolve, reject) => {
    let tmpDir;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protocol-pdf-'));
    } catch (e) {
      return reject(e);
    }
    const docxPath = path.join(tmpDir, 'protocol.docx');
    const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ } };
    try {
      fs.writeFileSync(docxPath, docxBuffer);
    } catch (e) {
      cleanup();
      return reject(e);
    }
    const soffice = process.env.SOFFICE_PATH || 'soffice';
    execFile(
      soffice,
      ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', tmpDir, docxPath],
      { timeout: 60000 },
      (err, stdout, stderr) => {
        if (err) {
          cleanup();
          return reject(new Error('Конвертация LibreOffice не удалась: ' + (stderr || err.message)));
        }
        const pdfPath = path.join(tmpDir, 'protocol.pdf');
        try {
          const buf = fs.readFileSync(pdfPath);
          cleanup();
          resolve(buf);
        } catch (e) {
          cleanup();
          reject(e);
        }
      }
    );
  });
}

// Рисует поверх итогового PDF (после конвертации docx→pdf) отдельную дополнительную
// страницу со статусом электронного подписания и подписями комиссии (п.7 ТЗ) — этого
// блока в самом Word-шаблоне нет. Возвращает новый Buffer.
async function appendSignatureOverlayPage(basePdfBuffer, { protocol, signatures }) {
  const pdfDoc = await PDFLibDocument.load(basePdfBuffer);
  const fontReg = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const PAGE_W = 595.28, PAGE_H = 841.89; // A4 в pt
  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
  const marginX = 40;
  let y = PAGE_H - 50;

  const drawText = (text, opts = {}) => {
    const { size = 10, bold = false, color = rgb(0, 0, 0), x = marginX, align = 'left' } = opts;
    const font = bold ? fontBold : fontReg;
    let tx = x;
    if (align === 'center') {
      const w = font.widthOfTextAtSize(String(text), size);
      tx = (PAGE_W - w) / 2;
    }
    page.drawText(String(text), { x: tx, y, size, font, color });
  };

  drawText(`ПРОТОКОЛ № ${protocol.protocol_number} — электронное подписание`, { size: 13, bold: true, align: 'center' });
  y -= 22;

  const sigByRole = Object.fromEntries((signatures || []).map(s => [s.committee_role, s]));
  const allSigned = COMMITTEE_ROLES.every(r => sigByRole[r]);

  drawText('Статус подписания:', { size: 10.5, bold: true });
  y -= 16;
  COMMITTEE_ROLES.forEach((role) => {
    const s = sigByRole[role];
    const mark = s ? 'Подписан' : 'Ожидает подписи';
    const who = s ? `— ${(s.last_name || '')} ${(s.first_name || '')}`.trim() + (s.signed_at ? `, ${fmtDateTime(s.signed_at)}` : '') : '';
    drawText(`${COMMITTEE_ROLE_LABELS[role]}: ${mark}  ${who}`, { size: 9.5, color: s ? rgb(0.04, 0.48, 0.24) : rgb(0.63, 0.36, 0) });
    y -= 15;
  });
  y -= 6;
  drawText(`Общий статус: ${allSigned ? 'Полностью подписан' : 'Частично подписан'}`, { size: 10, bold: true, color: allSigned ? rgb(0.04, 0.48, 0.24) : rgb(0.63, 0.36, 0) });
  y -= 34;

  drawText('Подписи комиссии', { size: 11, bold: true });
  y -= 24;

  const colW = (PAGE_W - marginX * 2) / 3;
  const rowTop = y;
  for (let i = 0; i < COMMITTEE_ROLES.length; i++) {
    const role = COMMITTEE_ROLES[i];
    const s = sigByRole[role];
    const colX = marginX + i * colW;
    const label = COMMITTEE_ROLE_LABELS[role];
    const labelW = fontReg.widthOfTextAtSize(label, 8.5);
    page.drawText(label, { x: colX + (colW - labelW) / 2, y: rowTop, size: 8.5, font: fontReg, color: rgb(0.27, 0.27, 0.27) });

    let sigBottom = rowTop - 16;
    if (s && s.signature_data) {
      const buf = sigImageBuffer(s.signature_data);
      if (buf) {
        try {
          const isPng = buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a';
          const img = isPng ? await pdfDoc.embedPng(buf) : await pdfDoc.embedJpg(buf);
          const targetW = 110, targetH = 40;
          const scale = Math.min(targetW / img.width, targetH / img.height);
          const w = img.width * scale, h = img.height * scale;
          page.drawImage(img, { x: colX + (colW - w) / 2, y: rowTop - 16 - h, width: w, height: h });
          sigBottom = rowTop - 16 - h;
        } catch (e) { /* пропускаем повреждённую картинку подписи */ }
      }
    }
    const lineY = sigBottom - 6;
    page.drawLine({ start: { x: colX + 10, y: lineY }, end: { x: colX + colW - 10, y: lineY }, thickness: 0.7, color: rgb(0.6, 0.6, 0.6) });

    const name = s ? `${s.last_name || ''} ${s.first_name || ''}`.trim() : '—';
    const nameW = fontReg.widthOfTextAtSize(name || '—', 8.2);
    page.drawText(name || '—', { x: colX + (colW - nameW) / 2, y: lineY - 12, size: 8.2, font: fontReg, color: rgb(0, 0, 0) });
    if (s && s.position) {
      const posW = fontReg.widthOfTextAtSize(s.position, 7.3);
      page.drawText(s.position, { x: colX + (colW - posW) / 2, y: lineY - 23, size: 7.3, font: fontReg, color: rgb(0.4, 0.4, 0.4) });
    }
    if (s && s.signed_at) {
      const dt = fmtDateTime(s.signed_at);
      const dtW = fontReg.widthOfTextAtSize(dt, 7.3);
      page.drawText(dt, { x: colX + (colW - dtW) / 2, y: lineY - 34, size: 7.3, font: fontReg, color: rgb(0.4, 0.4, 0.4) });
    }
  }

  y = rowTop - 90;
  const createdStr = fmtDate(protocol.created_at ? String(protocol.created_at).slice(0, 10) : protocol.open_date);
  let footer = `Версия протокола: ${protocol.pdf_version || 1}    Дата создания: ${createdStr}`;
  if (protocol.fully_signed_at) footer += `    Дата последнего подписания: ${fmtDateTime(protocol.fully_signed_at)}`;
  const footFont = 7.4;
  const footW = fontReg.widthOfTextAtSize(footer, footFont);
  page.drawText(footer, { x: (PAGE_W - footW) / 2, y, size: footFont, font: fontReg, color: rgb(0.53, 0.53, 0.53) });

  return Buffer.from(await pdfDoc.save());
}

// Точка входа, которую вызывает routes/protocols.js (GET /:id/pdf, POST /:id/sign).
// protocolMeta должен содержать { protocolNumber, openDate } в дополнение к тому, что уже
// приходит в protocol/members/signatures/companyName — см. routes/protocols.js.
async function buildProtocolPdf({ protocol, members, signatures, companyName }) {
  try {
    const { buffer: docxBuffer } = await buildProtocolDocx({
      protocolNumber: protocol.protocol_number,
      openDate: protocol.open_date,
      members
    });
    const basePdf = await convertDocxToPdf(docxBuffer);
    return await appendSignatureOverlayPage(basePdf, { protocol, signatures });
  } catch (e) {
    console.error('[protocolPdf] LibreOffice-конвертация недоступна, используется запасной вариант (pdfkit):', e.message);
    return buildProtocolPdfDrawn({ protocol, members, signatures, companyName });
  }
}

module.exports = { buildProtocolPdf, buildProtocolPdfDrawn };
