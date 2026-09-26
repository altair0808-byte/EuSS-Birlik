// Генерация Word-протокола (.docx) заседания экзаменационной комиссии по БиОТ.
// Берёт шаблон templates/protocol_template.docx (копия образца «Протокол по БиОТ № 027»:
// шапка с логотипом, таблица, подписи) и подставляет:
//   {{YEAR}} {{DAY}} {{MONTH}}  — дата ОТКРЫТИЯ протокола («2026 жылғы / года / year « 20 » Сентябрь»)
//   {{NUMBER}}                  — номер протокола («№ 027»)
//   строку таблицы с {{N}} {{CERT}} {{FIO}} {{BADGE}} {{POS}} {{DEPT}} {{MARK}} {{COMMENT}}
//                               — размножается по числу сотрудников протокола.
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const TEMPLATE_PATH = path.join(__dirname, 'templates', 'protocol_template.docx');

const MONTHS_RU = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

const MARK_PASSED = 'Прошел';
const MARK_FAILED = 'Подлежит повторной проверке знаний';

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

async function buildProtocolDocx({ protocolNumber, openDate, members }) {
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

  zip.file('word/document.xml', xml);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer, fileName: protocolFileName(openDate, protocolNumber), count: employees.length };
}

module.exports = { buildProtocolDocx, buildEmployeeRows, protocolFileName, toCyrillic, fullNameCyr, MONTHS_RU };
