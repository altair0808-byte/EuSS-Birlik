// «Сотрудник сдал / не сдал тест» — запись в колокольчик (таблица staff_notifications) + веб-пуш, если включён.
// Кто получает:
//   • тот, кто записал сотрудника на обучение (админ / суперадмин);
//   • ассистенты, в зону которых входит сотрудник (объект / отдел) и у которых есть функция этого курса
//     (БиОТ / внутреннее / внешнее обучение) — например, руководитель отдела видит результаты своих людей.
//     Записывать на обучение ассистенты по-прежнему не могут — только получают уведомления.
// Любая ошибка только пишется в лог: сдача теста сотрудником не должна из-за этого ломаться.
const { query } = require('../db');
const { hasFunction } = require('./adminFunctions');

// course_kind курса → функция, которая даёт к нему доступ (как в kindSqlFilter)
const KIND_FUNCTION = { internal: 'biot', no_protocol: 'internal', external: 'external' };

async function zoneAssistants(employee, courseKind) {
  const fn = KIND_FUNCTION[courseKind || 'internal'] || 'biot';
  const r = await query(
    `SELECT id, role, admin_functions FROM users
     WHERE role = 'assistant' AND COALESCE(active, 1) = 1
       AND (cardinality(assistant_objects) > 0 OR cardinality(assistant_departments) > 0)
       AND (cardinality(assistant_objects) = 0 OR $1 = ANY(assistant_objects))
       AND (cardinality(assistant_departments) = 0 OR $2 = ANY(assistant_departments))`,
    [employee.object || '', employee.department || '']);
  return r.rows.filter((u) => hasFunction(u, fn)).map((u) => Number(u.id));
}

async function notifyTestResult(assignment, passed, scorePercent) {
  try {
    if (!assignment) return;
    const [uRes, cRes] = await Promise.all([
      query('SELECT last_name, first_name, object, department FROM users WHERE id = $1', [assignment.user_id]),
      query('SELECT title_ru, title_kz, course_kind FROM courses WHERE id = $1', [assignment.course_id])
    ]);
    const u = uRes.rows[0] || {};
    const c = cRes.rows[0] || {};

    const recipients = new Set();
    // 1) кто записал (админ / суперадмин; запись из файла без назначившего — пропускаем)
    const assignerId = Number(assignment.assigned_by);
    if (assignerId) {
      const rRes = await query(
        `SELECT id FROM users WHERE id = $1 AND role IN ('admin', 'superadmin', 'assistant') AND COALESCE(active, 1) = 1`,
        [assignerId]);
      if (rRes.rows.length) recipients.add(assignerId);
    }
    // 2) ассистенты зоны сотрудника с функцией этого курса
    try { (await zoneAssistants(u, c.course_kind)).forEach((id) => recipients.add(id)); }
    catch (e) { console.error('[staffNotify] не удалось подобрать ассистентов зоны:', e.message); }
    if (!recipients.size) return;

    const fio = `${u.last_name || ''} ${u.first_name || ''}`.trim();
    const kind = passed ? 'test_passed' : 'test_failed';
    const ids = [...recipients];
    await query(
      `INSERT INTO staff_notifications (user_id, kind, assignment_id, employee_id, employee_name, course_title, score)
       SELECT r, $2, $3, $4, $5, $6, $7 FROM unnest($1::bigint[]) AS r`,
      [ids, kind, assignment.id, assignment.user_id, fio, c.title_ru || '', scorePercent]);
    try {
      const push = require('./push');
      await push.notifyUsers(ids, (lang) => ({
        title: passed
          ? (lang === 'kz' ? `✅ Тест тапсырылды — ${fio}` : `✅ Сдал тест — ${fio}`)
          : (lang === 'kz' ? `❌ Тест тапсырылмады — ${fio}` : `❌ Не сдал тест — ${fio}`),
        body: `${(lang === 'kz' ? (c.title_kz || c.title_ru) : c.title_ru) || ''} — ${scorePercent}%`,
        tag: `result-${assignment.id}`
      }));
    } catch (e) { /* пуш необязателен */ }
  } catch (e) {
    console.error('[staffNotify] не удалось записать уведомление о результате теста:', e.message);
  }
}

module.exports = { notifyTestResult };
