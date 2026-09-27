// Word-версия удостоверения (.docx) — та же архитектура, что и у протокола
// (JSZip собирает .docx как есть), но БЕЗ файла-образца: заказчик прислал только
// картинку-образец дизайна (для протокола есть готовый templates/protocol_template.docx,
// а для удостоверения — нет), поэтому документ строится программно с нуля: свой
// [Content_Types].xml, свои _rels, свой word/document.xml. Оформление сделано
// как можно ближе к присланному образцу (шапка с логотипом, крупный заголовок,
// ФИО, курс, даты, QR-код и печать/подпись внизу), но это не файл-копия картинки —
// когда появится реальный .docx-бланк удостоверения, эту генерацию стоит
// переключить на тот же приём, что и protocolDocx.js (шаблон + подстановка).
const JSZip = require('jszip');

const EMU_PER_PT = 12700;

function xmlEscape(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pngDimensions(buffer) {
  if (!buffer || buffer.length < 24) return null;
  if (buffer.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const CORE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Удостоверение БиОТ</dc:title>
  <dc:creator>TB Training Platform</dc:creator>
</cp:coreProperties>`;

const APP_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>TB Training Platform</Application>
</Properties>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="20"/></w:rPr></w:rPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
</w:styles>`;

function p({ text = '', bold = false, size = 20, color = '000000', align = 'center', spacingAfter = 60, font, italic = false }) {
  const rPr = `<w:rPr>${font ? `<w:rFonts w:ascii="${font}" w:hAnsi="${font}"/>` : ''}${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}<w:color w:val="${color}"/><w:sz w:val="${size}"/></w:rPr>`;
  return `<w:p><w:pPr><w:jc w:val="${align}"/><w:spacing w:after="${spacingAfter}"/></w:pPr><w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
}

function imageParagraph({ relId, widthPt, heightPt, align = 'center' }) {
  const cx = Math.round(widthPt * EMU_PER_PT);
  const cy = Math.round(heightPt * EMU_PER_PT);
  const id = 100 + Math.floor(Math.random() * 100000);
  return `<w:p><w:pPr><w:jc w:val="${align}"/></w:pPr><w:r><w:rPr><w:noProof/></w:rPr><w:drawing>`
    + `<wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">`
    + `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`
    + `<wp:docPr id="${id}" name="img${id}"/>`
    + `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>`
    + `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:nvPicPr><pic:cNvPr id="${id}" name="img${id}.png"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
    + `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('ru-RU');
}

function certificateFileName(cert) {
  const safeUid = String(cert.certificate_uid || cert.id).replace(/[\\/:*?"<>|]/g, '-');
  return `Удостоверение БиОТ № ${cert.certificate_number || safeUid}.docx`;
}

// Простая таблица без границ для трёх подписей комиссии (ЭТАП 2) — председатель /
// инженер по БиОТ / член комиссии, в один ряд, как в протоколе. sigImages[i] — PNG-буфер
// подписи соответствующей роли (или null, если роль ещё не подписала).
function committeeSignatureTable(committeeSignatures, sigImages, addImage) {
  const n = committeeSignatures.length;
  const cellW = Math.floor(9639 / n); // ширина рабочей области в twips (landscape A4 минус поля)
  const cellXml = committeeSignatures.map((m, i) => {
    const parts = [];
    parts.push(p({ text: m.label, bold: true, size: 15, spacingAfter: 40 }));
    const buf = sigImages[i];
    if (buf) {
      const img = addImage(buf, { maxWidthPt: 100, maxHeightPt: 32 });
      if (img) parts.push(imageParagraph(img));
    }
    parts.push(p({ text: '_______________________', size: 14, spacingAfter: 10 }));
    parts.push(p({ text: m.name || '—', size: 14, spacingAfter: 4 }));
    if (m.position) parts.push(p({ text: m.position, size: 11, color: '666666' }));
    return `<w:tc><w:tcPr><w:tcW w:w="${cellW}" w:type="dxa"/><w:tcBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/></w:tcBorders></w:tcPr>${parts.join('')}</w:tc>`;
  }).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="9639" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders></w:tblPr><w:tr>${cellXml}</w:tr></w:tbl>`;
}

// images: { logoBuf, qrBuf, stampBuf, sig1Buf, sig2Buf } — необязательные PNG-буферы
// (обратная совместимость, используются только если committeeSignatures не переданы)
// committeeSignatures — ЭТАП 2: [{ role, label, name, position, signature_data }, ...],
// полученные живьём из протокола (certificateService.js:getCommitteeSignaturesForProtocol).
// Удостоверение отдельно не подписывается — источник подписей всегда протокол.
async function buildCertificateDocx(cert, settings, verifyUrl, images = {}, committeeSignatures = null) {
  const s = settings || {};
  const zip = new JSZip();

  const relEntries = [];
  let nextRelId = 1;
  const bodyParts = [];

  const addImage = (buf, { maxWidthPt, maxHeightPt }) => {
    const dims = pngDimensions(buf);
    if (!buf || !dims) return null;
    const relId = `rId${nextRelId++}`;
    const mediaName = `media/img-${relId}.png`;
    zip.file(`word/${mediaName}`, buf);
    relEntries.push({ id: relId, target: mediaName });
    const wPtFull = dims.width * 72 / 96;
    const hPtFull = dims.height * 72 / 96;
    const scale = Math.min(maxWidthPt / wPtFull, maxHeightPt / hPtFull, 1);
    return { relId, widthPt: wPtFull * scale, heightPt: hPtFull * scale };
  };

  if (images.logoBuf) {
    const img = addImage(images.logoBuf, { maxWidthPt: 90, maxHeightPt: 55 });
    if (img) bodyParts.push(imageParagraph({ ...img, align: 'left' }));
  }

  bodyParts.push(p({ text: s.company_name || 'ТОО «Компания»', bold: true, size: 26, color: '0f3b6c' }));
  bodyParts.push(p({ text: ' ', size: 8, spacingAfter: 40 }));
  bodyParts.push(p({ text: 'УДОСТОВЕРЕНИЕ О ПРОВЕРКЕ ЗНАНИЙ', bold: true, size: 40, color: '1b365d' }));
  bodyParts.push(p({ text: 'по вопросам безопасности и охраны труда / CERTIFICATE OF PASSING SAFETY TESTS', size: 17, color: '555555', italic: true }));
  bodyParts.push(p({ text: `№ ${cert.certificate_number || '—'}`, bold: true, size: 22 }));
  bodyParts.push(p({ text: 'Настоящим подтверждается, что / Осы арқылы расталады:', size: 19, color: '444444' }));
  bodyParts.push(p({ text: `${cert.last_name || ''} ${cert.first_name || ''}`.trim(), bold: true, size: 34 }));

  const empDetails = [cert.user_position, cert.department, cert.object].filter(Boolean).join(' • ');
  if (empDetails) bodyParts.push(p({ text: empDetails, size: 18, color: '555555' }));

  bodyParts.push(p({ text: 'успешно прошел(ла) проверку знаний по курсу / келесі курс бойынша білімін сәтті тексеруден өтті:', size: 19, color: '444444' }));
  bodyParts.push(p({ text: `«${cert.title_ru || cert.title_kz || 'Курс'}»`, bold: true, size: 24, color: '0f3b6c' }));

  const validUntilStr = cert.expiry_date ? fmtDate(cert.expiry_date) : 'бессрочно / мерзімсіз';
  const protStr = cert.protocol_number ? `   Протокол № ${cert.protocol_number}` : '';
  bodyParts.push(p({ text: `Дата выдачи: ${fmtDate(cert.issue_date)}   Действителен до: ${validUntilStr}${protStr}`, size: 17, spacingAfter: 200 }));

  // Подпись/печать
  if (Array.isArray(committeeSignatures) && committeeSignatures.length) {
    const sigImages = committeeSignatures.map((m) => {
      if (!m.signature_data || typeof m.signature_data !== 'string' || !m.signature_data.startsWith('data:image')) return null;
      const idx = m.signature_data.indexOf('base64,');
      if (idx === -1) return null;
      try { return Buffer.from(m.signature_data.slice(idx + 7), 'base64'); } catch (e) { return null; }
    });
    bodyParts.push(committeeSignatureTable(committeeSignatures, sigImages, addImage));
    bodyParts.push(p({ text: ' ', size: 8, spacingAfter: 120 }));
    if (images.stampBuf) {
      const img = addImage(images.stampBuf, { maxWidthPt: 90, maxHeightPt: 90 });
      if (img) bodyParts.push(imageParagraph(img));
    }
  } else {
    // Обратная совместимость: без связанного протокола — прежняя однопредседательская схема.
    const isChair2Active = parseInt(s.active_chairman, 10) === 2;
    const activeChair = isChair2Active
      ? { role: s.chairman2_position || 'Председатель комиссии', name: s.chairman2_name || '—', sig: images.sig2Buf }
      : { role: s.chairman1_position || 'Председатель комиссии', name: s.chairman1_name || s.chairman_name || '—', sig: images.sig1Buf };

    bodyParts.push(p({ text: activeChair.role, bold: true, size: 17 }));
    if (activeChair.sig) {
      const img = addImage(activeChair.sig, { maxWidthPt: 130, maxHeightPt: 46 });
      if (img) bodyParts.push(imageParagraph(img));
    }
    bodyParts.push(p({ text: '_______________________', size: 17, spacingAfter: 20 }));
    bodyParts.push(p({ text: activeChair.name, size: 17, spacingAfter: 260 }));

    if (images.stampBuf) {
      const img = addImage(images.stampBuf, { maxWidthPt: 90, maxHeightPt: 90 });
      if (img) bodyParts.push(imageParagraph(img));
    }
  }

  // QR-код и статус — правая часть нижнего блока (в простом линейном докx кладём отдельным блоком снизу)
  const statusLabels = { VALID: 'ДЕЙСТВИТЕЛЬНО / VALID', EXPIRED: 'СРОК ИСТЁК / EXPIRED', REVOKED: 'АННУЛИРОВАНО / REVOKED' };
  bodyParts.push(p({ text: statusLabels[cert.status] || statusLabels.VALID, bold: true, size: 18, color: cert.status === 'VALID' ? '0f7a3c' : 'b91c1c' }));
  if (images.qrBuf) {
    const img = addImage(images.qrBuf, { maxWidthPt: 70, maxHeightPt: 70 });
    if (img) bodyParts.push(imageParagraph(img));
  }
  bodyParts.push(p({ text: `Проверить подлинность / Verify: ${verifyUrl}`, size: 14, color: '666666' }));
  bodyParts.push(p({ text: cert.certificate_uid || '', size: 14, color: '999999' }));

  const sectPr = `<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="720" w:right="900" w:bottom="720" w:left="900" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`;

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>${bodyParts.join('')}${sectPr}</w:body>
</w:document>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  ${relEntries.map((r) => `<Relationship Id="${r.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${r.target}"/>`).join('\n  ')}
</Relationships>`;

  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('docProps/core.xml', CORE_XML);
  zip.file('docProps/app.xml', APP_XML);
  zip.file('word/document.xml', documentXml);
  zip.file('word/styles.xml', STYLES_XML);
  zip.file('word/_rels/document.xml.rels', relsXml);

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer, fileName: certificateFileName(cert) };
}

module.exports = { buildCertificateDocx, certificateFileName };
