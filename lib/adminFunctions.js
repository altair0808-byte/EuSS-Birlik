// Функции администратора: суперадмин выдаёт каждому админу одну или несколько функций.
//   biot     — БиОТ (наши курсы с тестом/протоколом/удостоверением и сами протоколы)
//   internal — внутреннее обучение (курсы «без протокола»)
//   external — внешнее обучение (курсы, которые провела другая организация)
//   medbook  — медицинские книжки
// Суперадмин имеет все функции всегда. Ассистента эти ограничения не касаются (у него своя зона).
const { query } = require('../db');

const ADMIN_FUNCTIONS = ['biot', 'internal', 'external', 'medbook'];

// Упрощённая версия сайта: переменная окружения ENABLED_FUNCTIONS (через запятую) включает только нужные
// разделы для ВСЕХ ролей — суперадмина, админов, ассистентов и сотрудников. Например:
//   ENABLED_FUNCTIONS=biot,medbook   — только БиОТ и санкнижки (внутреннее и внешнее обучение скрыты полностью).
// Не задано / пусто — всё включено, как раньше. Вахта, сотрудники, журнал и настройки от этого не зависят.
// Данные в базе не удаляются: если вернуть функцию в список, всё снова появится.
const ENABLED_FUNCTIONS = (() => {
  const raw = String(process.env.ENABLED_FUNCTIONS || '').split(/[\s,;]+/).map((v) => v.trim().toLowerCase()).filter(Boolean);
  const list = ADMIN_FUNCTIONS.filter((f) => raw.includes(f));
  if (raw.length && !list.length) console.error('[functions] ENABLED_FUNCTIONS не содержит ни одной известной функции — включено всё');
  return list.length ? list : ADMIN_FUNCTIONS.slice();
})();
if (ENABLED_FUNCTIONS.length < ADMIN_FUNCTIONS.length) {
  console.log(`[functions] Упрощённый режим: включены только ${ENABLED_FUNCTIONS.join(', ')}`);
}
function isFunctionEnabled(fn) { return ENABLED_FUNCTIONS.includes(fn); }
function enabledFunctions() { return ENABLED_FUNCTIONS.slice(); }
// Виды курсов, разрешённые на сайте (protocol → biot, no_protocol → internal, external → external)
const KIND_OF_FUNCTION = { biot: 'internal', internal: 'no_protocol', external: 'external' };
function siteKindsSqlList() {
  return ['biot', 'internal', 'external'].filter(isFunctionEnabled).map((f) => `'${KIND_OF_FUNCTION[f]}'`);
}
// SQL-условие «вид курса включён на сайте» — для всех ролей (сотрудник, публичная страница, напоминания).
function siteKindSql(alias) {
  const kinds = siteKindsSqlList();
  if (kinds.length === 3) return 'TRUE';
  return kinds.length ? `${alias}.course_kind IN (${kinds.join(',')})` : 'FALSE';
}
const ADMIN_FUNCTION_LABELS = {
  biot: 'БиОТ',
  internal: 'Внутреннее обучение',
  external: 'Внешнее обучение',
  medbook: 'Мед. книжки'
};

// Приводит присланное к чистому списку допустимых функций (без дублей, в стабильном порядке).
// undefined -> undefined (поле не менять). Недопустимое значение -> ошибка.
function normalizeAdminFunctions(value) {
  if (value === undefined) return undefined;
  const arr = Array.isArray(value) ? value : [];
  const clean = arr.map((v) => String(v || '').trim()).filter(Boolean);
  const bad = clean.find((v) => !ADMIN_FUNCTIONS.includes(v));
  if (bad) throw new Error('invalid_admin_function');
  return ADMIN_FUNCTIONS.filter((f) => clean.includes(f));
}

// Есть ли у пользователя функция. superadmin — всегда; admin — только выданные; прочие роли — не проверяем здесь.
function hasFunction(user, fn) {
  if (!user) return false;
  if (!isFunctionEnabled(fn)) return false;
  if (user.role === 'superadmin') return true;
  if (user.role !== 'admin') return false;
  return Array.isArray(user.admin_functions) && user.admin_functions.includes(fn);
}

// Список функций, доступных пользователю (для admin — выданные, для superadmin — все)
function allowedFunctions(user) {
  if (!user) return [];
  if (user.role === 'superadmin') return enabledFunctions();
  if (user.role === 'admin') return ENABLED_FUNCTIONS.filter((f) => (user.admin_functions || []).includes(f));
  return [];
}

// Вид курса -> функция: protocol (наш курс) -> biot, no_protocol -> internal, external -> external
function functionOfCourseKind(kind) {
  if (kind === 'external') return 'external';
  if (kind === 'no_protocol') return 'internal';
  return 'biot';
}

async function functionOfCourse(courseId) {
  const r = await query('SELECT course_kind FROM courses WHERE id = $1', [courseId]);
  if (!r.rows[0]) return null;
  return functionOfCourseKind(r.rows[0].course_kind);
}

// Может ли пользователь работать с курсом данного вида. Для не-админов (ассистент, сотрудник) ограничения нет —
// их доступ по-прежнему определяют requireRole и зона.
function canUseCourseKind(user, kind) {
  if (!isFunctionEnabled(functionOfCourseKind(kind))) return false;
  if (!user || user.role !== 'admin') return true;
  return hasFunction(user, functionOfCourseKind(kind));
}

// SQL-условие «вид курса разрешён пользователю» (для админа — по его функциям; для остальных — без ограничения).
// Значения — только наши константы, пользовательский ввод в SQL не попадает.
function kindSqlFilter(user, alias) {
  if (!user || user.role !== 'admin') return siteKindSql(alias);
  const kinds = [];
  if (hasFunction(user, 'biot')) kinds.push("'internal'");
  if (hasFunction(user, 'internal')) kinds.push("'no_protocol'");
  if (hasFunction(user, 'external')) kinds.push("'external'");
  return kinds.length ? `${alias}.course_kind IN (${kinds.join(',')})` : 'FALSE';
}

const DENIED_SITE = { error: 'function_disabled', message: 'Этот раздел отключён на этом сайте.' };
const DENIED = { error: 'forbidden_function', message: 'Эта функция вам не назначена. Обратитесь к суперадмину.' };

// Middleware: админ должен иметь хотя бы одну из функций. Остальные роли не ограничиваются.
function requireAdminFunction(...fns) {
  return (req, res, next) => {
    if (!fns.some(isFunctionEnabled)) return res.status(403).json(DENIED_SITE);
    if (!req.user || req.user.role !== 'admin') return next();
    if (fns.some((f) => hasFunction(req.user, f))) return next();
    return res.status(403).json(DENIED);
  };
}

// Middleware для маршрутов с курсом: id курса берётся функцией getId(req).
function requireCourseFunction(getId) {
  return async (req, res, next) => {
    try {
      const id = getId(req);
      if (!id) return next();
      const fn = await functionOfCourse(id);
      if (!fn) return next(); // курса нет — пусть обработчик вернёт свою 404
      if (!isFunctionEnabled(fn)) return res.status(403).json(DENIED_SITE);
      if (!req.user || req.user.role !== 'admin') return next();
      if (hasFunction(req.user, fn)) return next();
      return res.status(403).json(DENIED);
    } catch (e) {
      return res.status(500).json({ error: 'server_error', details: e.message });
    }
  };
}

// Middleware для маршрутов с назначением (assignments.id): функция определяется курсом этого назначения.
function requireAssignmentFunction(getId) {
  return async (req, res, next) => {
    try {
      const id = getId(req);
      if (!id) return next();
      const r = await query('SELECT course_id FROM assignments WHERE id = $1', [id]);
      if (!r.rows[0]) return next();
      const fn = await functionOfCourse(r.rows[0].course_id);
      if (fn && !isFunctionEnabled(fn)) return res.status(403).json(DENIED_SITE);
      if (!req.user || req.user.role !== 'admin') return next();
      if (!fn || hasFunction(req.user, fn)) return next();
      return res.status(403).json(DENIED);
    } catch (e) {
      return res.status(500).json({ error: 'server_error', details: e.message });
    }
  };
}

module.exports = {
  requireAssignmentFunction,
  ADMIN_FUNCTIONS, ADMIN_FUNCTION_LABELS, normalizeAdminFunctions, hasFunction, allowedFunctions,
  functionOfCourseKind, functionOfCourse, canUseCourseKind, kindSqlFilter, requireAdminFunction, requireCourseFunction, DENIED,
  isFunctionEnabled, enabledFunctions, siteKindSql, DENIED_SITE
};
