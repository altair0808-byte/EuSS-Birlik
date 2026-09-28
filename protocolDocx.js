// Генерация Word-протокола (.docx) заседания экзаменационной комиссии по БиОТ.
// Берёт шаблон templates/protocol_template.docx (копия образца «Протокол по БиОТ № 027»:
// шапка с логотипом, таблица, подписи) и подставляет:
//   {{YEAR}} {{DAY}} {{MONTH}}  — дата ОТКРЫТИЯ протокола («2026 жылғы / года / year « 20 » Сентябрь»)
//   {{NUMBER}}                  — номер протокола («№ 027»)
//   строку таблицы с {{N}} {{CERT}} {{FIO}} {{BADGE}} {{POS}} {{DEPT}} {{MARK}} {{COMMENT}}
//                               — размножается по числу сотрудников протокола.
//
// ПОДХОД К СОСТАВУ КОМИССИИ И ПОДПИСЯМ (важно для дальнейшей поддержки):
// В самом .docx НЕТ текстовых плейсхолдеров вида {{HEADER_CHAIRMAN}} — верхняя шапка
// «Мына құрамдағы комиссия / Комиссия в составе» и нижний блок подписей в шаблоне
// оформлены как обычный статичный текст с линиями подчёркивания. Вместо того чтобы
// просить дизайнера переразметить бланк под новые плейсхолдеры (риск сломать вёрстку
// и рассинхронизироваться с «эталонным» образцом «Протокол по БиОТ № 027», под который
// уже сверстан шаблон), мы находим эти строки ПО ТОЧНОМУ XML СОВПАДЕНИЮ конкретного
// <w:r> (runXml) и подменяем его целиком. Это менее «декларативно», чем {{PLACEHOLDER}},
// но не требует трогать сам .docx и проверено рендером реального шаблона (см. ниже про
// печать) — если кто-то отредактирует шаблон в Word и хоть немного изменит форматирование
// этих строк (например, снимет курсив), совпадение перестанет находиться и соответствующая
// строка просто останется пустой, как в шаблоне (мягкий отказ, а не падение с ошибкой).
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { measureTextPt } = require('./lib/textWidth');

const TEMPLATE_PATH = path.join(__dirname, 'templates', 'protocol_template.docx');

const MONTHS_RU = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

const MARK_PASSED = 'Прошел';
const MARK_FAILED = 'Подлежит повторной проверке знаний';

// ---------- Электронные подписи в самом бланке (без отдельной страницы) ----------
// Задача: скачанный «подписанный» протокол должен выглядеть РОВНО как присланный
// образец (templates/protocol_template.docx / «Протокол по БиОТ № 027»), а не как этот
// же бланк плюс отдельно дорисованная страница со статусом подписания.
// Решение: в самом бланке три строки для подписи комиссии — каждая это ОДИН <w:r> с
// текстом вида «___(ФИО)___    ___(подпись)___» (два подчёркнутых участка через пробел).
// Когда роль подписала — заменяем этот один run на несколько: (1) ФИО+должность подписанта
// подчёркнутым текстом на месте первого участка, (2) исходный отступ, (3) картинка
// подписи (JSZip просто добавляет файл в word/media/ и связь в document.xml.rels —
// сам подписанный документ.xml ссылается на неё как на обычную вставленную картинку),
// и — только для председателя, только если передана печать организации — (4) печать
// поверх подписи (см. embedStampRun).
// Роль, которая ещё не подписала — её строка остаётся как в шаблоне (пустая линия).
const SIGNATURE_LINE_TARGETS = [
  {
    role: 'chairman',
    // «Комиссия төрағасы / Председатель комиссии / Chairman:» — строка подписи ниже
    runXml: '<w:r><w:rPr><w:b/><w:bCs/><w:i/></w:rPr><w:t>___________________________________________________________________                      ______________________</w:t></w:r>',
    maxWidthPt: 120,
    maxHeightPt: 34
  },
  {
    role: 'biot_engineer',
    // первая строка под «Комиссия мүшелері / Члены комиссии / Members:»
    runXml: '<w:r><w:rPr><w:b/><w:sz w:val="24"/></w:rPr><w:t>________________________________________________________                   _________________</w:t></w:r>',
    maxWidthPt: 105,
    maxHeightPt: 32
  },
  {
    role: 'member',
    // вторая строка под «Members:»
    runXml: '<w:r><w:rPr><w:i/><w:iCs/><w:sz w:val="14"/><w:szCs w:val="14"/></w:rPr><w:t>_______________________________________________________________________________________________                                     ____________________________</w:t></w:r>',
    maxWidthPt: 100,
    maxHeightPt: 26
  }
];

// Верхние строки шапки протокола («Председателя ____», и две строки под «комиссия
// мүшелері / и членов комиссии / Members» — Инженер по БиОТ и Представитель работников).
// Это просто справочная строка «кто в комиссии», без картинки подписи — «должность, ФИО»
// (для всех трёх ролей, включая председателя, должность берётся из БД — users.position)
// подставляется как обычный подчёркнутый текст на месте линии, поэтому структура документа
// не меняется (не добавляются/не сдвигаются строки).
// Заполняется по той же логике, что и подписи внизу: как только человек с этой
// ролью реально подписал протокол — здесь появляется его ФИО (т.к. ролей
// "инженер"/"представитель" в комиссии может быть несколько человек, а нужен именно
// тот, кто подписал).
const HEADER_LINE_TARGETS = [
  {
    role: 'chairman',
    runXml: '<w:r><w:rPr><w:sz w:val="22"/></w:rPr><w:t xml:space="preserve"> ________________________________________________________________</w:t></w:r>'
  },
  {
    role: 'biot_engineer',
    runXml: '<w:r><w:rPr><w:sz w:val="16"/></w:rPr><w:t>__________________________________________________________________________________________________</w:t></w:r>'
  },
  {
    role: 'member',
    runXml: '<w:r><w:rPr><w:sz w:val="16"/></w:rPr><w:t>_________________________________________________________________________________________________</w:t></w:r>'
  }
];

const EMU_PER_PT = 12700;

// ---------- Печать организации ----------
// Печать ставится РОВНО ОДИН раз на весь документ, привязана к блоку подписи
// председателя (т.к. это единственная роль в SIGNATURE_LINE_TARGETS, для которой мы
// её обрабатываем) и появляется, только когда передана И председатель подписал.
// Вставляется как «плавающая» картинка (DrawingML <wp:anchor>, а не <wp:inline>), потому
// что только якорь позволяет перекрыть уже вставленную инлайн-картинку подписи —
// инлайн-картинки в Word всегда идут строго одна за другой по тексту и накладываться
// друг на друга не могут.
//
// Смещения ниже — НЕ «на глаз»: они подобраны рендером реального шаблона
// (LibreOffice --convert-to pdf → pdftoppm, 150 DPI) с последующим измерением
// пикселей подписи/печати. При таком калибре печать перекрывает ~20% площади подписи
// (ТЗ п.3–4), не задевает ни текст ФИО/должности председателя, ни соседние заголовки
// «Chairman:» сверху и «Члены комиссии / Members:» снизу (ТЗ п.7–8).
// Если шаблон протокола поменяется (другой шрифт/интервалы в этой строке), эти три
// константы нужно перекалибровать тем же способом — см. STAMP_CALIBRATION.md.
// Размер печати увеличен в 1.5 раза (было 80 pt). Смещения пересчитаны так, чтобы печать не вылезла
// за край листа (ширина A4 = 595 pt, поэтому правый край ≤ 590) и не закрывала таблицу выше
// (низ таблицы ≈ 531 pt при верхе абзаца председателя 561 pt): круг 120 pt занимает x 470–590, y 531–651.
// Проверено наложением на рендер шаблона (LibreOffice → PDF).
const STAMP_DIAMETER_PT = 120;        // ~42 мм
const STAMP_OFFSET_X_PT = 470;        // от левого края страницы (positionH relativeFrom="page")
const STAMP_OFFSET_Y_PT = -30;        // от верха абзаца со строкой подписи председателя (relativeFrom="paragraph")

// Ширина/высота PNG из заголовка (IHDR), без внешних зависимостей.
function pngDimensions(buffer) {
  if (!buffer || buffer.length < 24) return null;
  if (buffer.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// Подпись приходит с фронтенда и хранится в users.signature_data как
// data:image/png;base64,... (canvas.toDataURL()). Печать организации в этом проекте
// хранится в settings.stamp_data/stamp_path и уже приводится к Buffer в routes через
// общий для проекта resolveImageBuffer() (см. routes/certificate.js, certificatePdf.js) —
// поэтому companyStamp принимаем и как готовый Buffer, и как data:image-строку, чтобы
// не плодить ещё один вариант декодирования того же самого.
function decodePngImage(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value !== 'string' || !value.startsWith('data:image')) return null;
  const idx = value.indexOf('base64,');
  if (idx === -1) return null;
  try { return Buffer.from(value.slice(idx + 7), 'base64'); } catch (e) { return null; }
}

// Печать из настроек может быть JPG или PNG с белым фоном (скан/фото). Раньше такая печать
// молча пропускалась (читаем только PNG), а непрозрачный белый квадрат закрыл бы подпись.
// Приводим к PNG и, если у изображения нет прозрачности, «вымываем» белый фон в прозрачность
// (color-to-alpha: чем темнее пиксель, тем он непрозрачнее). Печать с готовой прозрачностью
// не трогаем. sharp — уже зависимость проекта; если его нет, остаётся прежнее поведение.
async function normalizeStampToPng(value) {
  const buf = decodePngImage(value);
  if (!buf) return null;
  let sharp;
  try { sharp = require('sharp'); } catch (e) { return pngDimensions(buf) ? buf : null; }
  try {
    const meta = await sharp(buf).metadata();
    if (meta.hasAlpha && pngDimensions(buf)) return buf;
    const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (!meta.hasAlpha) {
      for (let i = 0; i < data.length; i += 4) {
        const a = 255 - Math.min(data[i], data[i + 1], data[i + 2]);
        if (a === 0) { data[i] = data[i + 1] = data[i + 2] = 0; data[i + 3] = 0; continue; }
        data[i] = Math.round((data[i] - (255 - a)) * 255 / a);
        data[i + 1] = Math.round((data[i + 1] - (255 - a)) * 255 / a);
        data[i + 2] = Math.round((data[i + 2] - (255 - a)) * 255 / a);
        data[i + 3] = a;
      }
    }
    return await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  } catch (e) {
    console.warn('[protocolDocx] Не удалось обработать печать, пропускаем:', e.message);
    return pngDimensions(buf) ? buf : null;
  }
}

let sigDocPrCounter = 900001; // произвольный диапазон id/z-order, не пересекающийся с шаблоном

function buildInlineImageXml({ relId, cx, cy }) {
  const id = sigDocPrCounter++;
  return '<w:r><w:rPr><w:noProof/></w:rPr><w:drawing>'
    + `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>`
    + '<wp:effectExtent l="0" t="0" r="0" b="0"/>'
    + `<wp:docPr id="${id}" name="Signature${id}"/>`
    + '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>'
    + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + `<pic:nvPicPr><pic:cNvPr id="${id}" name="Signature${id}.png"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
    + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
}

// Плавающая картинка печати. behindDoc="0" — печать поверх подписи (как в жизни, штамп
// кладут поверх уже расписанного листа); allowOverlap="1" — разрешаем перекрытие с
// инлайн-картинкой подписи, иначе Word может попытаться «оттолкнуть» соседний контент.
function buildStampAnchorXml({ relId, cx, cy, offsetXEmu, offsetYEmu }) {
  const id = sigDocPrCounter++;
  return '<w:r><w:rPr><w:noProof/></w:rPr><w:drawing>'
    + `<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${id}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">`
    + '<wp:simplePos x="0" y="0"/>'
    + `<wp:positionH relativeFrom="page"><wp:posOffset>${offsetXEmu}</wp:posOffset></wp:positionH>`
    + `<wp:positionV relativeFrom="paragraph"><wp:posOffset>${offsetYEmu}</wp:posOffset></wp:positionV>`
    + `<wp:extent cx="${cx}" cy="${cy}"/>`
    + '<wp:effectExtent l="0" t="0" r="0" b="0"/>'
    + '<wp:wrapNone/>'
    + `<wp:docPr id="${id}" name="CompanyStamp"/>`
    + '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>'
    + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + `<pic:nvPicPr><pic:cNvPr id="${id}" name="CompanyStamp.png"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom></pic:spPr>`
    + '</pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>';
}

// Подпись всегда «Должность, ФИО» (должность — users.position из БД, у ВСЕХ трёх ролей,
// включая председателя, и в шапке, и в нижнем блоке подписи). Если должность не заполнена —
// просто ФИО. buildLabel(label, fio) => "label, fio".
function buildLabel(label, fio) {
  const clean = cleanText(label);
  return cleanText(clean ? `${clean}, ${fio}` : fio);
}

// ---------- Подгонка текста под фиксированную зону бланка ----------
// Линия подчёркивания в шаблоне — это зона фиксированной ширины в pt (например, 335 pt у
// председателя внизу). Раньше текст «Должность, ФИО» добивался пробелами ПО ЧИСЛУ СИМВОЛОВ —
// а буквы и подчёркивания разной ширины, поэтому реальная ширина уплывала, и всё, что идёт
// дальше в той же строке (отступ + картинка подписи), переставало совпадать со статичной
// надписью «Подпись» строкой ниже. Теперь зона считается в pt (lib/textWidth.js), текст
// центрируется в ней, а остаток добивается пробелами с точной подстройкой межсимвольного
// интервала (w:spacing, в twips) — итоговая ширина = ширине исходной линии с точностью
// до 1 twip (1/20 pt). Если текст не влезает — кегль уменьшается (шаг 0.5 pt), и только
// потом, в крайнем случае, текст обрезается с «…».
const DEFAULT_RUN_SIZE_PT = 10; // Normal в шаблоне: w:sz=20

function runStyleFromRPr(rPrXml) {
  const sz = rPrXml.match(/<w:sz w:val="(\d+)"/);
  return {
    bold: /<w:b\/>/.test(rPrXml),
    italic: /<w:i\/>/.test(rPrXml),
    sizePt: sz ? parseInt(sz[1], 10) / 2 : DEFAULT_RUN_SIZE_PT
  };
}

// Собирает rPr из исходного: задаёт кегль, (опционально) межсимвольный интервал и подчёркивание.
// Порядок дочерних элементов — как в схеме (spacing → sz → szCs → u).
function composeRPr(rPrXml, { sizePt, spacingTw = 0, underline = true }) {
  let inner = rPrXml.replace(/^<w:rPr>/, '').replace(/<\/w:rPr>$/, '')
    .replace(/<w:sz w:val="\d+"\/>/g, '')
    .replace(/<w:szCs w:val="\d+"\/>/g, '')
    .replace(/<w:spacing w:val="-?\d+"\/>/g, '')
    .replace(/<w:u\b[^>]*\/>/g, '');
  const half = Math.round(sizePt * 2);
  const tail = (spacingTw ? `<w:spacing w:val="${spacingTw}"/>` : '')
    + `<w:sz w:val="${half}"/><w:szCs w:val="${half}"/>`
    + (underline ? '<w:u w:val="single"/>' : '');
  const langIdx = inner.indexOf('<w:lang');
  inner = langIdx === -1 ? inner + tail : inner.slice(0, langIdx) + tail + inner.slice(langIdx);
  return `<w:rPr>${inner}</w:rPr>`;
}

// Боковой отступ РОВНО заданной ширины (pt) в кегле/стиле исходной линии: целое число символов
// «_» (как в исходном шаблоне — линия остаётся непрерывной) + остаток меньше одного «_»,
// добитый подчёркнутыми пробелами с точной (только положительной) подстройкой w:spacing (в twips). Остаток стоит
// у текста (side='left' — после подчёркиваний, side='right' — перед ними), т.е. никогда не
// оказывается «хвостовым» пробелом абзаца: такие Word/LibreOffice схлопывают и не подчёркивают
// (у линии в шапке после неё в строке ничего нет). Неразрывные пробелы — той же ширины 0.25 em.
const NBSP = '\u00A0';

function buildSpacerRuns(rPrXml, style, widthPt, side) {
  const wantTw = Math.max(0, Math.round(widthPt * 20));
  const usTw = Math.round(measureTextPt('_', style.sizePt, style) * 20);
  const spaceTw = Math.round(measureTextPt(NBSP, style.sizePt, style) * 20);
  if (usTw <= 0 || spaceTw <= 0) return '';
  // один «_» оставляем в остатке: так остаток ≥ 2 пробелов и подстройка w:spacing остаётся мелкой
  const nU = Math.max(0, Math.floor(wantTw / usTw) - 1);
  const remTw = wantTw - nU * usTw;

  const underscores = nU > 0
    ? `<w:r>${composeRPr(rPrXml, { sizePt: style.sizePt, underline: false })}<w:t xml:space="preserve">${'_'.repeat(nU)}</w:t></w:r>`
    : '';

  let rest = '';
  if (remTw >= 2) {
    // floor, а не round: подстройка только положительная (LibreOffice игнорирует отрицательный w:spacing)
    const n = Math.max(1, Math.floor(remTw / spaceTw));
    const extra = remTw - n * spaceTw;              // на сколько twips растянуть n пробелов (≥ 0)
    const q = Math.floor(extra / n);
    const r = extra - q * n;                        // r пробелов получат q+1, остальные n-r — q
    const mk = (count, spacingTw) => count > 0
      ? `<w:r>${composeRPr(rPrXml, { sizePt: style.sizePt, spacingTw })}<w:t xml:space="preserve">${NBSP.repeat(count)}</w:t></w:r>`
      : '';
    rest = mk(n - r, q) + mk(r, q + 1);
  }
  return side === 'left' ? underscores + rest : rest + underscores;
}

// Текст «Должность, ФИО» подчёркнутым шрифтом, отцентрованный в зоне ширины zonePt (pt), с
// авто-уменьшением кегля. Общая ширина возвращаемых run-ов = zonePt.
// Если даже при минимальном кегле строка не влезает — сокращается ДОЛЖНОСТЬ («…»), ФИО
// сохраняется целиком (и только если не влезает уже одно ФИО — оно обрезается).
function buildFittedCenteredRun(rPrXml, position, fio, zonePt, { minSizePt = 6, marginPt = 2 } = {}) {
  const style = runStyleFromRPr(rPrXml);
  const avail = Math.max(0, zonePt - marginPt * 2);
  const width = (t, sz) => measureTextPt(t, sz, style);
  const posClean = cleanText(position);
  let text = buildLabel(posClean, fio);
  let size = style.sizePt;
  while (size > minSizePt && width(text, size) > avail) size -= 0.5;
  if (width(text, size) > avail) {
    const pos = [...posClean];
    while (pos.length && width(buildLabel(pos.join('').trimEnd() + '…', fio), size) > avail) pos.pop();
    if (pos.length) {
      text = buildLabel(pos.join('').trimEnd() + '…', fio);
    } else {
      const chars = [...cleanText(fio)];
      while (chars.length > 1 && width(chars.join('') + '…', size) > avail) chars.pop();
      text = chars.join('').trimEnd() + '…';
    }
  }
  const rem = Math.max(0, zonePt - width(text, size));
  const left = buildSpacerRuns(rPrXml, style, rem / 2, 'left');
  const right = buildSpacerRuns(rPrXml, style, rem - rem / 2, 'right');
  const textRun = `<w:r>${composeRPr(rPrXml, { sizePt: size })}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
  return left + textRun + right;
}

// Разбивает исходный run-текст «___(имя)___   ___(подпись)___» на 3 части.
function splitSignatureLine(text) {
  const m = text.match(/^(_+)(\s+)(_+)$/);
  if (!m) return null;
  return { nameBlank: m[1], gap: m[2], sigBlank: m[3] };
}

// Подставляет в xml шаблона реальные подписи членов комиссии, которые уже подписали
// (signaturesByRole: { chairman: {...}, biot_engineer: {...}, member: {...} }), и, если
// передана, печать организации (только у председателя, только один раз на документ).
// Мутирует zip (добавляет word/media/*.png и связи в document.xml.rels).
// Роли без подписи — соответствующая строка остаётся как в шаблоне (пустая).
async function embedSignaturesIntoXml(zip, xml, signaturesByRole, companyStamp) {
  if (!signaturesByRole || !Object.keys(signaturesByRole).length) return xml;

  let relsXml = null;
  let nextRelId = null;
  const ensureRels = async () => {
    if (relsXml === null) {
      relsXml = await zip.file('word/_rels/document.xml.rels').async('string');
      const ids = [...relsXml.matchAll(/Id="rId(\d+)"/g)].map((m2) => parseInt(m2[1], 10));
      nextRelId = (ids.length ? Math.max(...ids) : 0) + 1;
    }
  };
  const addMedia = async (buf, name) => {
    await ensureRels();
    const relId = `rId${nextRelId++}`;
    zip.file(`word/${name}`, buf);
    relsXml = relsXml.replace(
      '</Relationships>',
      `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${name}"/></Relationships>`
    );
    return relId;
  };

  for (const target of SIGNATURE_LINE_TARGETS) {
    const sig = signaturesByRole[target.role];
    if (!sig || !xml.includes(target.runXml)) continue;

    const rPrMatch = target.runXml.match(/^<w:r>(<w:rPr>.*?<\/w:rPr>)<w:t>/);
    const textMatch = target.runXml.match(/<w:t>(.*)<\/w:t>/);
    if (!rPrMatch || !textMatch) continue;
    const parts = splitSignatureLine(textMatch[1]);
    if (!parts) continue;

    const fio = fullNameCyr(sig.last_name, sig.first_name);
    const position = toCyrillic(cleanText(sig.position), false);
    // У всех трёх ролей (включая председателя) — «фактическая должность из БД, ФИО».
    // Зона ФИО = реальная ширина (pt) исходной линии подчёркивания; gap и картинка подписи
    // после неё стартуют ровно там же, где в чистом шаблоне (над надписью «Подпись»).
    const nameStyle = runStyleFromRPr(rPrMatch[1]);
    const nameZonePt = measureTextPt(parts.nameBlank, nameStyle.sizePt, nameStyle);
    const nameRun = buildFittedCenteredRun(rPrMatch[1], position, fio, nameZonePt);
    const gapRun = `<w:r>${rPrMatch[1]}<w:t xml:space="preserve">${xmlEscape(parts.gap)}</w:t></w:r>`;

    let sigRun;
    const imgBuf = decodePngImage(sig.signature_data);
    const dims = imgBuf ? pngDimensions(imgBuf) : null;
    if (imgBuf && dims && dims.width && dims.height) {
      const relId = await addMedia(imgBuf, `media/sig-${target.role}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`);
      const wPtFull = dims.width * 72 / 96;
      const hPtFull = dims.height * 72 / 96;
      const scale = Math.min(target.maxWidthPt / wPtFull, target.maxHeightPt / hPtFull, 1);
      const cx = Math.round(wPtFull * scale * EMU_PER_PT);
      const cy = Math.round(hPtFull * scale * EMU_PER_PT);
      sigRun = buildInlineImageXml({ relId, cx, cy });
    } else {
      // Подпись есть в БД, но картинку прочитать не удалось — не ломаем документ,
      // оставляем исходную линию для подписи как в шаблоне.
      sigRun = `<w:r>${rPrMatch[1]}<w:t xml:space="preserve">${xmlEscape(parts.sigBlank)}</w:t></w:r>`;
    }

    let stampRun = '';
    if (target.role === 'chairman' && companyStamp) {
      const stampBuf = decodePngImage(companyStamp);
      const stampDims = stampBuf ? pngDimensions(stampBuf) : null;
      if (stampBuf && stampDims && stampDims.width && stampDims.height) {
        const relId = await addMedia(stampBuf, `media/company-stamp-${Date.now()}.png`);
        const wPtFull = stampDims.width * 72 / 96;
        const scale = STAMP_DIAMETER_PT / wPtFull;
        const cx = Math.round(wPtFull * scale * EMU_PER_PT);
        const cy = Math.round(stampDims.height * 72 / 96 * scale * EMU_PER_PT);
        stampRun = buildStampAnchorXml({
          relId, cx, cy,
          offsetXEmu: Math.round(STAMP_OFFSET_X_PT * EMU_PER_PT),
          offsetYEmu: Math.round(STAMP_OFFSET_Y_PT * EMU_PER_PT)
        });
      }
      // Печать передана, но файл битый/не PNG — молча пропускаем, как и с подписью выше:
      // отсутствие печати не должно ронять генерацию всего протокола.
    }

    xml = xml.replace(target.runXml, () => nameRun + gapRun + sigRun + stampRun);
  }

  if (relsXml !== null) zip.file('word/_rels/document.xml.rels', relsXml);
  return xml;
}

// Заполняет верхние справочные строки шапки («Председателя ___», «Инженер по БиОТ»,
// «Представитель работников») — но только для тех ролей, кто уже реально подписал
// (signaturesByRole), т.к. на роли "инженер"/"представитель" в комиссии может быть
// назначено несколько человек, и заранее неизвестно, кто из них в итоге подпишет именно
// этот протокол. Не трогает медиа/rels — тут только текст, картинки нет.
// У всех трёх ролей, включая председателя, — «должность из БД, ФИО». Текст центрируется в
// зоне, равной реальной pt-ширине исходной линии подчёркивания (авто-уменьшение кегля),
// чтобы не сдвинуть остальной текст документа.
function embedHeaderNamesIntoXml(xml, signaturesByRole) {
  if (!signaturesByRole || !Object.keys(signaturesByRole).length) return xml;

  for (const target of HEADER_LINE_TARGETS) {
    const sig = signaturesByRole[target.role];
    if (!sig || !xml.includes(target.runXml)) continue;

    const rPrMatch = target.runXml.match(/^<w:r>(<w:rPr>.*?<\/w:rPr>)<w:t/);
    const textMatch = target.runXml.match(/<w:t[^>]*>(.*)<\/w:t>/);
    if (!rPrMatch || !textMatch) continue;
    const m = textMatch[1].match(/^(\s*)(_+)$/);
    if (!m) continue;

    const fio = fullNameCyr(sig.last_name, sig.first_name);
    const position = toCyrillic(cleanText(sig.position), false);

    const style = runStyleFromRPr(rPrMatch[1]);
    const zonePt = measureTextPt(m[2], style.sizePt, style);
    // ведущий пробел перед линией (у председателя) сохраняем как есть, вне зоны
    const leadRun = m[1]
      ? `<w:r>${rPrMatch[1]}<w:t xml:space="preserve">${m[1]}</w:t></w:r>`
      : '';

    xml = xml.replace(target.runXml, () => leadRun + buildFittedCenteredRun(rPrMatch[1], position, fio, zonePt));
  }

  return xml;
}

function xmlEscape(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- Кириллица ----------
// Латинские буквы, внешне неотличимые от кириллических (частая опечатка при вводе: «Kуанышбекова»
// с латинской K). Внутри слова, где уже есть кириллица, заменяем их на кириллические.
const LOOKALIKE = {
  A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У',
  a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у'
};
// Транслитерация слова, целиком написанного латиницей (только для ФИО).
const TRANSLIT_DIGRAPHS = [
  ['shch', 'щ'], ['sch', 'щ'], ['zh', 'ж'], ['kh', 'х'], ['ch', 'ч'], ['sh', 'ш'], ['ts', 'ц'],
  ['yu', 'ю'], ['ya', 'я'], ['yo', 'ё'], ['ye', 'е'], ['ay', 'ай'], ['iy', 'ий'], ['ey', 'ей'], ['oy', 'ой'], ['uy', 'уй']
];
const TRANSLIT_SINGLE = {
  a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'и', j: 'ж', k: 'к', l: 'л', m: 'м',
  n: 'н', o: 'о', p: 'п', q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'кс', y: 'ы', z: 'з'
};
const RE_LAT = /[A-Za-z]/;
const RE_CYR = /[\u0400-\u04FF]/;

function transliterateWord(word) {
  const lower = word.toLowerCase();
  let out = '';
  for (let i = 0; i < lower.length;) {
    let matched = false;
    for (const [lat, cyr] of TRANSLIT_DIGRAPHS) {
      if (lower.startsWith(lat, i)) { out += cyr; i += lat.length; matched = true; break; }
    }
    if (matched) continue;
    const ch = lower[i];
    out += TRANSLIT_SINGLE[ch] !== undefined ? TRANSLIT_SINGLE[ch] : ch;
    i++;
  }
  // сохраняем заглавную первую букву («Kuanyshbekova» → «Куанышбекова»)
  if (word[0] === word[0].toUpperCase() && out) out = out[0].toUpperCase() + out.slice(1);
  return out;
}

// allowTranslit=true — для ФИО: слово целиком латиницей переводим в кириллицу.
// Для должностей/участков (могут содержать аббревиатуры вроде «HSE») целиком латинские слова не трогаем.
function toCyrillic(text, allowTranslit) {
  return String(text ?? '').replace(/[A-Za-z\u0400-\u04FF]+/g, (word) => {
    if (!RE_LAT.test(word)) return word;
    if (RE_CYR.test(word)) return word.replace(/[A-Za-z]/g, (c) => LOOKALIKE[c] || c);   // смесь → заменяем двойников
    return allowTranslit ? transliterateWord(word) : word;
  });
}

function cleanText(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

// «Иванов Иван» — фамилия и имя (при наличии отчества в поле имени оно тоже попадёт в ячейку).
function fullNameCyr(lastName, firstName) {
  return toCyrillic(cleanText(`${lastName || ''} ${firstName || ''}`), true);
}

// ---------- Данные ----------
// members — строки из БД (по одной на назначение); внутри протокола сотрудник указывается один раз:
// В готовый протокол включаются только сотрудники, успешно прошедшие проверку.
function buildEmployeeRows(members) {
  const byUser = new Map();
  for (const m of members) {
    let e = byUser.get(m.user_id);
    if (!e) { e = { ...m, allPassed: true }; byUser.set(m.user_id, e); }
    if (m.status !== 'passed') e.allPassed = false;
  }
  return [...byUser.values()].filter((e) => e.allPassed).map((e, i) => ({
    n: `${i + 1}.`,
    cert: cleanText(e.permanent_certificate_number),
    fio: fullNameCyr(e.last_name, e.first_name),
    badge: cleanText(e.tco_badge),
    pos: toCyrillic(cleanText(e.position), false),
    dept: toCyrillic(cleanText(e.department) || cleanText(e.object), false),
    mark: e.allPassed ? MARK_PASSED : MARK_FAILED,
    comment: ''
  }));
}

// dateStr — 'YYYY-MM-DD' (дата открытия протокола)
function splitDate(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error('Некорректная дата открытия протокола');
  return { year: m[1], day: m[3], monthIndex: parseInt(m[2], 10) - 1, iso: `${m[1]}-${m[2]}-${m[3]}` };
}

function protocolFileName(dateStr, number) {
  const { iso } = splitDate(dateStr);
  const safeNumber = cleanText(number).replace(/[\\/:*?"<>|]/g, '-');
  return `${iso} Протокол по БиОТ № ${safeNumber}.docx`;
}

// signatures — необязательный массив, как отдаёт loadProtocolSignatures() в routes/protocols.js:
// [{ committee_role, last_name, first_name, position, signature_data }, ...]. Роли, которых нет
// в массиве (ещё не подписали), остаются в бланке пустыми линиями — как в исходном шаблоне.
// companyStamp — необязательный data:image/png;base64,... с прозрачным фоном; печать
// появляется только если председатель есть среди signatures И передан companyStamp.
async function buildProtocolDocx({ protocolNumber, openDate, members, signatures, companyStamp }) {
  const zip = await JSZip.loadAsync(fs.readFileSync(TEMPLATE_PATH));
  let xml = await zip.file('word/document.xml').async('string');

  const d = splitDate(openDate);
  xml = xml
    .replace('{{YEAR}}', () => xmlEscape(d.year))
    .replace('{{DAY}}', () => xmlEscape(d.day))
    .replace('{{MONTH}}', () => xmlEscape(MONTHS_RU[d.monthIndex]))
    .replace('{{NUMBER}}', () => xmlEscape(cleanText(protocolNumber)));

  // строка-образец таблицы → по строке на сотрудника
  const rowRe = /<w:tr[ >](?:(?!<w:tr[ >]).)*?\{\{FIO\}\}.*?<\/w:tr>/s;
  const rowMatch = xml.match(rowRe);
  if (!rowMatch) throw new Error('В шаблоне протокола не найдена строка таблицы');
  const rowTpl = rowMatch[0];
  const employees = buildEmployeeRows(members);
  const rowsXml = employees.map((e) => rowTpl
    .replace('{{N}}', () => xmlEscape(e.n))
    .replace('{{CERT}}', () => xmlEscape(e.cert))
    .replace('{{FIO}}', () => xmlEscape(e.fio))
    .replace('{{BADGE}}', () => xmlEscape(e.badge))
    .replace('{{POS}}', () => xmlEscape(e.pos))
    .replace('{{DEPT}}', () => xmlEscape(e.dept))
    .replace('{{MARK}}', () => xmlEscape(e.mark))
    .replace('{{COMMENT}}', () => xmlEscape(e.comment))
  ).join('');
  // функция-замена, чтобы «$» в данных не воспринимался как спецпоследовательность
  xml = xml.replace(rowRe, () => rowsXml);

  if (Array.isArray(signatures) && signatures.length) {
    const byRole = Object.fromEntries(signatures.map((s) => [s.committee_role, s]));
    xml = await embedSignaturesIntoXml(zip, xml, byRole, byRole.chairman ? await normalizeStampToPng(companyStamp) : null);
    xml = embedHeaderNamesIntoXml(xml, byRole);
  }

  zip.file('word/document.xml', xml);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer, fileName: protocolFileName(openDate, protocolNumber), count: employees.length };
}

module.exports = { buildProtocolDocx, buildEmployeeRows, protocolFileName, toCyrillic, fullNameCyr, MONTHS_RU };
