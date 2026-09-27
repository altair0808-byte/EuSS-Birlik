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

const TEMPLATE_PATH = path.join(__dirname, 'templates', 'protocol_template.docx');

const MONTHS_RU = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

const MARK_PASSED = 'Прошел';
const MARK_FAILED = 'Подлежит повторной проверке знаний';

// Фиксированная подпись роли для НИЖНЕГО блока подписи председателя (там, в отличие от
// инженера/члена комиссии, слева печатается не его должность из БД, а именно роль в
// комиссии — см. ТЗ: «Председатель комиссии, Иванов Иван Иванович»).
const CHAIRMAN_ROLE_LABEL = 'Председатель комиссии';

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
// Это просто справочная строка «кто в комиссии», без картинки подписи — ФИО (и, для
// инженера/члена, должность) подставляются как обычный подчёркнутый текст в ТОТ ЖЕ run,
// поэтому структура документа не меняется (не добавляются/не сдвигаются строки).
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
const STAMP_DIAMETER_PT = 80;         // ~28 мм в печати — умещается между соседними строками этого бланка
const STAMP_OFFSET_X_PT = 504;        // от левого края страницы (positionH relativeFrom="page")
const STAMP_OFFSET_Y_PT = -12;        // от верха абзаца со строкой подписи председателя (relativeFrom="paragraph")

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

function injectUnderline(rPrXml) {
  if (/<w:u\b/.test(rPrXml)) return rPrXml;
  return rPrXml.replace(/<\/w:rPr>$/, '<w:u w:val="single"/></w:rPr>');
}

// Разбивает исходный run-текст «___(имя)___   ___(подпись)___» на 3 части.
function splitSignatureLine(text) {
  const m = text.match(/^(_+)(\s+)(_+)$/);
  if (!m) return null;
  return { nameBlank: m[1], gap: m[2], sigBlank: m[3] };
}

// Подпись всегда «ФИО, должность» — единый формат для верхней шапки (инженер/член) и
// нижнего блока (все три роли), см. примеры в ТЗ:
//   «Инженер по БиОТ, Петров Петр Петрович» — на самом деле в ТЗ порядок «должность, ФИО»
// В коде это buildLabel(label, fio) => "label, fio".
function buildLabel(label, fio) {
  const clean = cleanText(label);
  return cleanText(clean ? `${clean}, ${fio}` : fio);
}

// Подставляет в один run из *_LINE_TARGETS готовый ФИО-текст (подчёркнутый), сохраняя
// исходную длину линии подчёркивания (дополняем пробелами) — чтобы не сдвинуть
// остальной текст документа и не менять структуру абзаца.
function buildPaddedNameRun(rPrXml, blankLen, label) {
  const nameRPr = injectUnderline(rPrXml);
  const pad = ' '.repeat(Math.max(1, blankLen - label.length - 1));
  return `<w:r>${nameRPr}<w:t xml:space="preserve"> ${xmlEscape(label)}${pad}</w:t></w:r>`;
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
    // Нижний блок подписи председателя подписывается ролью в комиссии («Председатель
    // комиссии»), а не его личной должностью из БД — см. ТЗ и CHAIRMAN_ROLE_LABEL выше.
    // Для инженера/члена комиссии внизу — их фактическая должность, как у председателя
    // была бы, если б её отображали: «должность, ФИО».
    const nameLabel = target.role === 'chairman'
      ? buildLabel(CHAIRMAN_ROLE_LABEL, fio)
      : buildLabel(position, fio);
    const nameRun = buildPaddedNameRun(rPrMatch[1], parts.nameBlank.length, nameLabel);
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

    xml = xml.replace(target.runXml, nameRun + gapRun + sigRun + stampRun);
  }

  if (relsXml !== null) zip.file('word/_rels/document.xml.rels', relsXml);
  return xml;
}

// Заполняет верхние справочные строки шапки («Председателя ___», «Инженер по БиОТ»,
// «Представитель работников») — но только для тех ролей, кто уже реально подписал
// (signaturesByRole), т.к. на роли "инженер"/"представитель" в комиссии может быть
// назначено несколько человек, и заранее неизвестно, кто из них в итоге подпишет именно
// этот протокол. Не трогает медиа/rels — тут только текст, картинки нет.
// Председатель в шапке — только ФИО (без должности), инженер/член — «должность, ФИО»,
// как и в примерах ТЗ. Строка укорачивается/дополняется пробелами до исходной длины
// подчёркивания, чтобы не сдвинуть остальной текст документа.
function embedHeaderNamesIntoXml(xml, signaturesByRole) {
  if (!signaturesByRole || !Object.keys(signaturesByRole).length) return xml;

  for (const target of HEADER_LINE_TARGETS) {
    const sig = signaturesByRole[target.role];
    if (!sig || !xml.includes(target.runXml)) continue;

    const rPrMatch = target.runXml.match(/^<w:r>(<w:rPr>.*?<\/w:rPr>)<w:t/);
    const textMatch = target.runXml.match(/<w:t[^>]*>(.*)<\/w:t>/);
    if (!rPrMatch || !textMatch) continue;
    const originalLen = textMatch[1].length;

    const fio = fullNameCyr(sig.last_name, sig.first_name);
    const position = toCyrillic(cleanText(sig.position), false);
    const nameLabel = target.role === 'chairman' ? fio : buildLabel(position, fio);
    const nameRun = buildPaddedNameRun(rPrMatch[1], originalLen, nameLabel);

    xml = xml.replace(target.runXml, nameRun);
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
    xml = await embedSignaturesIntoXml(zip, xml, byRole, companyStamp);
    xml = embedHeaderNamesIntoXml(xml, byRole);
  }

  zip.file('word/document.xml', xml);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer, fileName: protocolFileName(openDate, protocolNumber), count: employees.length };
}

module.exports = { buildProtocolDocx, buildEmployeeRows, protocolFileName, toCyrillic, fullNameCyr, MONTHS_RU };
