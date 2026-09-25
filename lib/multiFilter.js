// Разбирает значение query-параметра фильтра, которое теперь может быть не только
// одним значением, но и несколькими, через запятую (мульти-выбор объектов/отделов/
// должностей/статусов на фронте — см. index.html, компонент multiSelect). Раньше везде
// был просто `req.query.object` (одно значение) — теперь `splitMulti(req.query.object)`
// возвращает массив, который подставляется в SQL через `= ANY($n::text[])` вместо `= $n`.
// Совместимо со старыми ссылками/закладками с одним значением — просто массив из одного элемента.
function splitMulti(val) {
  if (val === undefined || val === null || val === '') return [];
  if (Array.isArray(val)) return val.map(v => String(v).trim()).filter(Boolean);
  return String(val).split(',').map(v => v.trim()).filter(Boolean);
}

module.exports = { splitMulti };
