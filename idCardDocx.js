// Word-версия УДОСТОВЕРЕНИЯ (не сертификата!).
//
// ВРЕМЕННЫЙ БЛАНК — повторяет по содержанию PDF-версию (idCardPdf.js), чтобы Word и PDF
// не расходились. Когда заказчик пришлёт образец удостоверения, меняется вёрстка здесь
// и в idCardPdf.js — оба файла должны меняться ВМЕСТЕ.
//
// Собирается минимальный .docx через JSZip (зависимость уже есть в проекте), без шаблона.
const JSZip = require('jszip');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('ru-RU');
}

function para(text, { bold = false, size = 22, align = 'left', color = '000000', space = 60 } = {}) {
  return '<w:p><w:pPr>'
    + `<w:spacing w:after="${space}"/>`
    + `<w:jc w:val="${align}"/>`
    + `<w:rPr>${bold ? '<w:b/>' : ''}<w:color w:val="${color}"/><w:sz w:val="${size}"/></w:rPr>`
    + '</w:pPr>'
    + `<w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:color w:val="${color}"/><w:sz w:val="${size}"/></w:rPr>`
    + `<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

function cell(text, { bold = false, w = 4680 } = {}) {
  return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr>`
    + para(text, { bold, size: 20, space: 20 })
    + '</w:tc>';
}

function row(label, value) {
  return '<w:tr>' + cell(label, { w: 3600 }) + cell(value, { bold: true, w: 5760 }) + '</w:tr>';
}

// card / settings / verifyUrl / committeeSignatures — как в idCardPdf.js
async function buildIdCardDocx(card, settings, verifyUrl, committeeSignatures) {
  const sigs = (Array.isArray(committeeSignatures) && committeeSignatures.length)
    ? committeeSignatures
    : [{ label: 'Председатель комиссии' }, { label: 'Инженер по БиОТ' }, { label: 'Член комиссии' }];

  const body = [
    para(settings.company_name || '', { bold: true, size: 24, align: 'center', color: '0F3B6C' }),
    para('УДОСТОВЕРЕНИЕ', { bold: true, size: 40, align: 'center', color: '12305A' }),
    para('КУӘЛІК / CERTIFICATE OF QUALIFICATION', { size: 20, align: 'center', color: '5B6B80' }),
    para(`№ ${card.card_number || '—'}`, { bold: true, size: 28, align: 'center', color: '0F3B6C', space: 200 }),
    '<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/>'
      + '<w:tblBorders>'
      + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
        .map((s) => `<w:${s} w:val="single" w:sz="4" w:color="C8D4E3"/>`).join('')
      + '</w:tblBorders></w:tblPr>'
      + '<w:tblGrid><w:gridCol w:w="3600"/><w:gridCol w:w="5760"/></w:tblGrid>'
      + row('Ф.И.О. / Т.А.Ә.', `${card.last_name || ''} ${card.first_name || ''}`.trim() || '—')
      + row('Должность / Лауазымы', card.user_position || '—')
      + row('Подразделение / Бөлім', [card.department, card.object].filter(Boolean).join(' · ') || '—')
      + row('Проверка знаний по курсу', card.title_ru || '—')
      + row('Протокол комиссии №', card.protocol_number ? String(card.protocol_number) : '—')
      + row('Дата выдачи / Берілген күні', fmtDate(card.issue_date))
      + row('Действительно до / Жарамды', card.expiry_date ? fmtDate(card.expiry_date) : 'бессрочно')
      + '</w:tbl>',
    para('', { space: 200 }),
    para('Комиссия / Комиссия мүшелері', { bold: true, size: 20, color: '64748B' })
  ];

  sigs.forEach((s) => {
    const name = s.name ? s.name : '____________________';
    const pos = s.position ? `, ${s.position}` : '';
    body.push(para(`${s.label || ''}:   ${name}${pos}   ____________________`, { size: 20, space: 80 }));
  });

  body.push(para(`UID: ${card.card_uid || ''}`, { size: 16, align: 'center', color: '94A3B8', space: 40 }));
  if (verifyUrl) body.push(para(`Проверка подлинности: ${verifyUrl}`, { size: 16, align: 'center', color: '94A3B8' }));

  const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:body>' + body.join('')
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
    + '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/>'
    + '</w:sectPr></w:body></w:document>';

  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>');
  zip.file('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>');
  zip.file('word/_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
  zip.file('word/document.xml', documentXml);

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const fileName = `Удостоверение_${card.card_number || card.card_uid}.docx`;
  return { buffer, fileName };
}

module.exports = { buildIdCardDocx };
