// Измерение реальной ширины строки в пунктах для Liberation Serif — шрифт по умолчанию
// в templates/protocol_template.docx (см. word/styles.xml → w:docDefaults → w:rFonts).
// Нужно, чтобы верхний блок комиссии (protocolDocx.js → embedHeaderNamesIntoXml) мог:
//   1) центрировать «Должность, ФИО» строго внутри исходной pt-ширины линии подчёркивания
//      (а не по числу символов — пробел/буква в пропорциональном шрифте разной ширины,
//      из-за чего подстановка «плыла» и линия могла сдвигать остальной текст бланка);
//   2) уменьшать кегль только когда реально не влезает, а не «на глаз».
// Liberation Serif метрически совместим с Times New Roman (тот же .notdef/advance-width
// набор), поэтому даже если Word на компьютере пользователя подставит Times New Roman —
// ширины будут те же самые с точностью до долей пункта.
const path = require('path');
const PDFDocument = require('pdfkit');

const FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'LiberationSerif-Regular.ttf');
const FONT_NAME = 'LibSerifMeasure';

// Один переиспользуемый PDFDocument только для измерения (ничего не рендерим и не
// сохраняем — autoFirstPage:false, чтобы не создавать даже первую страницу).
let measureDoc = null;
function getMeasureDoc() {
  if (!measureDoc) {
    measureDoc = new PDFDocument({ autoFirstPage: false });
    measureDoc.registerFont(FONT_NAME, FONT_PATH);
  }
  return measureDoc;
}

// Ширина text в пунктах при кегле fontSizePt (в пунктах, не в полупунктах Word).
function widthOfText(text, fontSizePt) {
  const doc = getMeasureDoc();
  doc.font(FONT_NAME).fontSize(fontSizePt);
  return doc.widthOfString(String(text ?? ''));
}

module.exports = { widthOfText };
