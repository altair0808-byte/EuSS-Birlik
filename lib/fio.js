// Нормализация и транслитерация ФИО (п.9 доработки: «Сотрудники и защита от дублей»).
//
// Задача: «УТЯШЕВ АЛТАИР», «утяшев алтаир» и «Утяшев Алтаир» должны считаться
// одной и той же записью, а поиск — одинаково находить сотрудника и по
// русскому написанию, и по английской транслитерации («Utyashev», «Altair»).
//
// Транслитерация — не перевод (Привет -> Privet, а не Hello): используется
// таблица соответствия букв ГОСТ 7.79-2000 (система Б) / близкая к загранпаспортной,
// плюс казахские буквы (әғқңөұүhі), т.к. в системе встречаются казахские ФИО.

const TRANSLIT_MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  // Казахские буквы
  ә: 'a', ғ: 'gh', қ: 'q', ң: 'ng', ө: 'o', ұ: 'u', ү: 'u', h: 'h', і: 'i'
};

/**
 * Приводит ФИО (или любую строку) к единому формату для сравнения:
 * нижний регистр, ё -> е, схлопнутые пробелы, обрезка краёв.
 * "УТЯШЕВ   Алтаир" -> "утяшев алтаир"
 */
function normalizeFio(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Транслитерирует кириллическую строку в латиницу побуквенно (не перевод).
 * "Утяшев Алтаир" -> "Utyashev Altair"
 */
function transliterate(str) {
  const s = String(str || '');
  let out = '';
  for (const ch of s) {
    const lower = ch.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(TRANSLIT_MAP, lower)) {
      out += TRANSLIT_MAP[lower];
    } else {
      out += ch;
    }
  }
  // Капитализация первой буквы каждого слова — как в примере из ТЗ (Utyashev Altair)
  return out.replace(/(^|\s)([a-z])/g, (m, sep, c) => sep + c.toUpperCase());
}

/**
 * Строит вспомогательные поля для поиска/дедупа по фамилии+имени сотрудника:
 * - normalized: "фамилия имя" в нижнем регистре, для точного сравнения дублей;
 * - translit: латинская транслитерация "Фамилия Имя", для поиска по-английски.
 */
function computeFioFields(lastName, firstName) {
  const full = `${lastName || ''} ${firstName || ''}`.trim();
  return {
    normalized: normalizeFio(full),
    translit: transliterate(full)
  };
}

module.exports = { normalizeFio, transliterate, computeFioFields };
