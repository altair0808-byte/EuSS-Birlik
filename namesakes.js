// Тёзки: если по Фамилии+Имени нашлось несколько сотрудников, пробуем выбрать одного
// по дополнительным колонкам файла: «Номер пропуска» → «Отдел» → «Должность».
// Возвращает отфильтрованный список (или исходный, если уточнить не удалось).
function norm(s) { return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim(); }
function digits(s) { return String(s || '').replace(/\D/g, ''); }

function narrowNamesakes(found, { badge, dept, pos } = {}) {
  if (!found || found.length < 2) return found || [];
  let list = found;
  const b = digits(badge);
  if (b) {
    const hit = list.filter((u) => digits(u.tco_badge) === b);
    if (hit.length) list = hit;
  }
  const d = norm(dept);
  if (list.length > 1 && d) {
    const hit = list.filter((u) => u.department && (norm(u.department) === d || d.includes(norm(u.department))));
    if (hit.length) list = hit;
  }
  const p = norm(pos);
  if (list.length > 1 && p) {
    const hit = list.filter((u) => u.position && (norm(u.position) === p || p.includes(norm(u.position))));
    if (hit.length) list = hit;
  }
  return list;
}

// Подсказка в ошибке: кто именно совпал — чтобы было понятно, что дописать в файл
function namesakesHint(found) {
  return found.slice(0, 4).map((u) => {
    const bits = [u.department, u.position, u.tco_badge ? '№' + u.tco_badge : ''].filter(Boolean).join(', ');
    return bits ? `${u.last_name} ${u.first_name} (${bits})` : `${u.last_name} ${u.first_name}`;
  }).join('; ');
}

const NAMESAKE_HEADERS = {
  'номер пропуска': 'badge', '№ пропуска': 'badge', 'пропуск': 'badge', '№ пропуска тшо': 'badge', 'пропуск тшо': 'badge', 'tco badge': 'badge',
  'отдел': 'dept', 'департамент': 'dept',
  'должность': 'pos', 'должность на сайте': 'pos'
};

const NAMESAKE_ERROR = 'найдено несколько сотрудников с таким ФИО (тёзки) — добавьте в файл колонку «Номер пропуска» или «ИИН» (можно «Отдел» / «Должность»)';

module.exports = { narrowNamesakes, namesakesHint, NAMESAKE_HEADERS, NAMESAKE_ERROR };
