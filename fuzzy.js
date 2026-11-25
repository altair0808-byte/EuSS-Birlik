// «Похожий» поиск по ФИО: Мәжіров = Мажиров = Mazhirov = Mazhyrov.
// Строку приводим к «скелету» латиницей: казахские буквы → русские, кириллица → латиница,
// kh→h, y→i, j→zh, сдвоенные буквы → одна. Тот же алгоритм — в index.html (fuzzyKey).
const KZ = { 'ә': 'а', 'ғ': 'г', 'қ': 'к', 'ң': 'н', 'ө': 'о', 'ұ': 'у', 'ү': 'у', 'һ': 'х', 'і': 'и' };
const TR = { 'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e', 'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'i',
  'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'h',
  'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'sh', 'ъ': '', 'ы': 'i', 'ь': '', 'э': 'e', 'ю': 'iu', 'я': 'ia' };

function fuzzyKey(s) {
  let out = '';
  for (const ch0 of String(s || '').toLowerCase()) {
    const ch = KZ[ch0] || ch0;
    out += TR[ch] !== undefined ? TR[ch] : ch;
  }
  out = out.replace(/kh/g, 'h').replace(/y/g, 'i').replace(/j/g, 'zh').replace(/q/g, 'k').replace(/w/g, 'u').replace(/x/g, 'ks')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/(.)\1+/g, '$1').replace(/\s+/g, ' ').trim();
  return out;
}

function fuzzyHas(hay, q) {
  const qq = String(q || '').trim();
  if (!qq) return true;
  if (String(hay || '').toLowerCase().includes(qq.toLowerCase())) return true;
  const k = fuzzyKey(qq);
  return !!k && fuzzyKey(hay).includes(k);
}

module.exports = { fuzzyKey, fuzzyHas };
