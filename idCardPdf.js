// PDF УДОСТОВЕРЕНИЯ (не сертификата!).
//
// ВРЕМЕННЫЙ БЛАНК. Заказчик пришлёт образец удостоверения — тогда меняется только
// вёрстка внутри buildIdCardPdfBuffer(); данные, роуты и таблица id_cards остаются
// прежними.
//
// Отличия от сертификата (осознанно, чтобы документы не путали):
//   • формат A5 альбомный (карточка-разворот), а не A4;
//   • заголовок «УДОСТОВЕРЕНИЕ / КУӘЛІК»;
//   • крупно номер удостоверения = логин сотрудника;
//   • подписи комиссии берутся из протокола (как и в сертификате).
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

const FONT_REG = path.join(__dirname, 'assets', 'fonts', 'DejaVuSans.ttf');
const FONT_BOLD = path.join(__dirname, 'assets', 'fonts', 'DejaVuSans-Bold.ttf');

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('ru-RU');
}

function sigBuffer(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) return null;
  const idx = dataUrl.indexOf('base64,');
  if (idx === -1) return null;
  try { return Buffer.from(dataUrl.slice(idx + 7), 'base64'); } catch (e) { return null; }
}

// card — строка из getIdCardFullByUid(), settings — settings(id=1),
// verifyUrl — публичная ссылка проверки, committeeSignatures — из протокола.
async function buildIdCardPdfBuffer(card, settings, verifyUrl, committeeSignatures) {
  const qrBuf = verifyUrl
    ? await QRCode.toBuffer(verifyUrl, { type: 'png', margin: 1, width: 220 }).catch(() => null)
    : null;

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A5', layout: 'landscape', margins: { top: 26, bottom: 24, left: 30, right: 30 } });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const hasReg = fs.existsSync(FONT_REG);
      const hasBold = fs.existsSync(FONT_BOLD);
      if (hasReg) doc.registerFont('DejaVu', FONT_REG);
      if (hasBold) doc.registerFont('DejaVu-Bold', FONT_BOLD);
      const fReg = (s = 9) => { if (hasReg) doc.font('DejaVu'); doc.fontSize(s); };
      const fBold = (s = 9) => { if (hasBold) doc.font('DejaVu-Bold'); else if (hasReg) doc.font('DejaVu'); doc.fontSize(s); };

      const W = 595.28; // A5 альбомный = 595.28 x 419.53
      const H = 419.53;
      const L = 30;
      const CW = W - 60;

      // Рамка
      doc.lineWidth(1.6).strokeColor('#0f3b6c').rect(16, 14, W - 32, H - 28).stroke();
      doc.lineWidth(0.6).strokeColor('#8ea6c4').rect(22, 20, W - 44, H - 40).stroke();

      // Шапка
      fBold(11); doc.fillColor('#0f3b6c');
      doc.text(String(settings.company_name || ''), L, 34, { width: CW, align: 'center', height: 16, ellipsis: true });

      fBold(20); doc.fillColor('#12305a');
      doc.text('УДОСТОВЕРЕНИЕ', L, 56, { width: CW, align: 'center' });
      fReg(10); doc.fillColor('#5b6b80');
      doc.text('КУӘЛІК  /  CERTIFICATE OF QUALIFICATION', L, 80, { width: CW, align: 'center' });

      fBold(13); doc.fillColor('#0f3b6c');
      doc.text(`№ ${card.card_number || '—'}`, L, 98, { width: CW, align: 'center' });

      doc.moveTo(L, 120).lineTo(L + CW, 120).lineWidth(0.8).strokeColor('#c8d4e3').stroke();

      // Поля
      const rows = [
        ['Ф.И.О. / Т.А.Ә.', `${card.last_name || ''} ${card.first_name || ''}`.trim() || '—'],
        ['Должность / Лауазымы', card.user_position || '—'],
        ['Подразделение / Бөлім', [card.department, card.object].filter(Boolean).join(' · ') || '—'],
        ['Проверка знаний по курсу', card.title_ru || '—'],
        ['Протокол комиссии №', card.protocol_number ? String(card.protocol_number) : '—'],
        ['Дата выдачи / Берілген күні', fmtDate(card.issue_date)],
        ['Действительно до / Жарамды', card.expiry_date ? fmtDate(card.expiry_date) : 'бессрочно']
      ];

      let y = 132;
      const labelW = 170;
      rows.forEach(([label, value]) => {
        fReg(8.6); doc.fillColor('#64748b');
        doc.text(label, L, y, { width: labelW, height: 12, ellipsis: true });
        fBold(9.6); doc.fillColor('#12233a');
        doc.text(String(value), L + labelW, y - 1, { width: CW - labelW - 120, height: 13, ellipsis: true });
        y += 19;
      });

      // QR + UID справа
      if (qrBuf) {
        try { doc.image(qrBuf, L + CW - 92, 132, { fit: [86, 86] }); } catch (e) { /* ignore */ }
      }
      fReg(6.6); doc.fillColor('#94a3b8');
      doc.text(String(card.card_uid || ''), L + CW - 110, 222, { width: 110, align: 'center' });

      // Подписи комиссии (из протокола)
      const sigs = Array.isArray(committeeSignatures) ? committeeSignatures : [];
      const sigTop = 286;
      fReg(8); doc.fillColor('#64748b');
      doc.text('Комиссия / Комиссия мүшелері', L, sigTop - 14, { width: CW });

      const colW = CW / Math.max(1, sigs.length || 3);
      (sigs.length ? sigs : [{ label: 'Председатель комиссии' }, { label: 'Инженер по БиОТ' }, { label: 'Член комиссии' }])
        .forEach((s, i) => {
          const x = L + i * colW;
          const img = s.signed ? sigBuffer(s.signature_data) : null;
          if (img) {
            try { doc.image(img, x + colW / 2 - 40, sigTop, { fit: [80, 28] }); } catch (e) { /* ignore */ }
          }
          const lineY = sigTop + 32;
          doc.moveTo(x + 8, lineY).lineTo(x + colW - 16, lineY).lineWidth(0.7).strokeColor('#9aa8ba').stroke();
          fReg(7.6); doc.fillColor('#12233a');
          doc.text(s.name || '—', x, lineY + 4, { width: colW - 10, align: 'center', height: 11, ellipsis: true });
          fReg(6.8); doc.fillColor('#7a8798');
          doc.text(s.label || '', x, lineY + 15, { width: colW - 10, align: 'center', height: 10, ellipsis: true });
        });

      fReg(6.4); doc.fillColor('#9aa8ba');
      doc.text('Подлинность документа проверяется по QR-коду', L, H - 40, { width: CW, align: 'center' });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildIdCardPdfBuffer };
