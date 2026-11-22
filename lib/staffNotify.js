// «Сотрудник, которого вы записали, сдал / не сдал тест» — запись в колокольчик администратора
// (таблица staff_notifications) + веб-пуш на его устройства, если пуши включены.
// Любая ошибка только пишется в лог: сдача теста сотрудником не должна из-за этого ломаться.
const { query } = require('../db');

async function notifyTestResult(assignment, passed, scorePercent) {
  try {
    const recipientId = Number(assignment && assignment.assigned_by);
    if (!recipientId) return; // запись загружена из файла / без назначившего
    const rRes = await query(
      `SELECT id FROM users WHERE id = $1 AND role IN ('admin', 'superadmin', 'assistant') AND COALESCE(active, 1) = 1`,
      [recipientId]);
    if (!rRes.rows.length) return;
    const [uRes, cRes] = await Promise.all([
      query('SELECT last_name, first_name FROM users WHERE id = $1', [assignment.user_id]),
      query('SELECT title_ru, title_kz FROM courses WHERE id = $1', [assignment.course_id])
    ]);
    const u = uRes.rows[0] || {};
    const c = cRes.rows[0] || {};
    const fio = `${u.last_name || ''} ${u.first_name || ''}`.trim();
    const kind = passed ? 'test_passed' : 'test_failed';
    await query(
      `INSERT INTO staff_notifications (user_id, kind, assignment_id, employee_id, employee_name, course_title, score)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [recipientId, kind, assignment.id, assignment.user_id, fio, c.title_ru || '', scorePercent]);
    try {
      const push = require('./push');
      await push.notifyUsers([recipientId], (lang) => ({
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
