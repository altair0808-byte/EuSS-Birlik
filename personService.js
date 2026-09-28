// ДАННЫЕ УДОСТОВЕРЕНИЙ СОТРУДНИКА (для общего QR и вкладки «Мои удостоверения»).
//
// Модель: на каждый вид обучения — своё удостоверение (таблица id_cards, idCardService.js),
// цвет бланка задаёт courses.card_color, подписи/печать — из протокола. А QR на каждом
// бланке ОДИН на сотрудника: /p/<users.public_uid> — страница со списком всех его обучений.
//
// Если у сотрудника по одному курсу несколько удостоверений (пересдача/продление),
// в списке показывается только самое свежее — по нему считается статус.
const { query } = require('./db');
const { computeLiveStatus, ensureIdCardForAssignment } = require('./idCardService');

// Досоздаёт удостоверения по сданным назначениям, у которых их ещё нет (идемпотентно).
async function ensureCardsForEmployee(userId) {
  const r = await query(
    `SELECT a.id FROM assignments a
     WHERE a.user_id = $1 AND a.status = 'passed'
       AND NOT EXISTS (SELECT 1 FROM id_cards c WHERE c.assignment_id = a.id)`,
    [userId]
  );
  for (const row of r.rows) {
    try { await ensureIdCardForAssignment(row.id); } catch (e) { console.error('ensureIdCard error:', e.message); }
  }
}

// Самые свежие удостоверения по каждому курсу, с живым статусом.
async function loadLatestCards(userId) {
  const res = await query(
    `SELECT card.id, card.card_uid, card.card_number, card.status, card.issue_date, card.expiry_date,
            card.assignment_id, card.course_id,
            c.title_ru, c.title_kz, c.card_color, c.is_external,
            a.score_percent, a.test_date,
            COALESCE(p.protocol_number, a.protocol_number) AS protocol_number
     FROM id_cards card
     LEFT JOIN courses c ON c.id = card.course_id
     LEFT JOIN protocols p ON p.id = card.protocol_id
     JOIN assignments a ON a.id = card.assignment_id
     WHERE card.employee_id = $1
     ORDER BY card.issue_date DESC NULLS LAST, card.id DESC`,
    [userId]
  );
  const seen = new Set();
  const out = [];
  for (const r of res.rows) {
    const key = r.course_id == null ? `card-${r.id}` : `course-${r.course_id}`;
    if (seen.has(key)) continue; // строки идут от новых к старым — первая и есть самая свежая
    seen.add(key);
    out.push({ ...r, status: computeLiveStatus(r.status, r.expiry_date) });
  }
  return out;
}

// NONE — удостоверений нет; VALID — все действуют; PARTIAL — часть действует;
// EXPIRED / REVOKED — не действует ни одно (причина — по большинству: есть аннулированное -> REVOKED).
function computeOverallStatus(cards) {
  if (!cards.length) return 'NONE';
  const valid = cards.filter((c) => c.status === 'VALID').length;
  if (valid === cards.length) return 'VALID';
  if (valid > 0) return 'PARTIAL';
  return cards.some((c) => c.status === 'REVOKED') ? 'REVOKED' : 'EXPIRED';
}

async function loadEmployer() {
  const r = await query('SELECT company_name FROM settings WHERE id = 1');
  return (r.rows[0] && r.rows[0].company_name) || '';
}

async function buildPerson(userRow) {
  await ensureCardsForEmployee(userRow.id);
  const cards = await loadLatestCards(userRow.id);
  return {
    user: userRow,
    employer: await loadEmployer(),
    card_number: userRow.login || (cards[0] && cards[0].card_number) || '',
    cards,
    overall_status: computeOverallStatus(cards)
  };
}

const USER_COLS = `id, last_name, first_name, position, department, object, login, public_uid`;

// Для авторизованных роутов: только сотрудник (role = 'employee').
async function getPersonForCard(employeeId) {
  const r = await query(`SELECT ${USER_COLS} FROM users WHERE id = $1 AND role = 'employee'`, [employeeId]);
  return r.rows[0] ? buildPerson(r.rows[0]) : null;
}

// Для публичного роута — по постоянному public_uid.
async function getPersonByPublicUid(publicUid) {
  const r = await query(`SELECT ${USER_COLS} FROM users WHERE public_uid = $1 AND role = 'employee'`, [publicUid]);
  return r.rows[0] ? buildPerson(r.rows[0]) : null;
}

function toDateOnly(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// ПУБЛИЧНЫЙ вид: только то, что печатается на бланке. Никаких id, логина, ИИН, телефона, card_uid.
function toPublicPayload(person, employer) {
  const u = person.user;
  return {
    found: true,
    full_name: `${u.last_name || ''} ${u.first_name || ''}`.trim(),
    position: u.position || '',
    department: u.department || u.object || '',
    employer: employer || person.employer || '',
    overall_status: person.overall_status,
    courses: person.cards.map((c) => ({
      title_ru: c.title_ru || '',
      title_kz: c.title_kz || '',
      color: c.card_color || null,
      external: !!c.is_external, // внешний курс: без нашего протокола/подписи/печати (для пометки на странице)
      test_date: toDateOnly(c.test_date) || toDateOnly(c.issue_date),
      score_percent: c.score_percent == null ? null : c.score_percent,
      protocol_number: c.protocol_number ? String(c.protocol_number) : '',
      valid_until: toDateOnly(c.expiry_date), // null = бессрочно
      status: c.status
    }))
  };
}

async function getPublicProfile(publicUid) {
  const person = await getPersonByPublicUid(publicUid);
  return person ? toPublicPayload(person, person.employer) : null;
}

module.exports = {
  ensureCardsForEmployee,
  computeOverallStatus,
  getPersonForCard,
  getPersonByPublicUid,
  toPublicPayload,
  getPublicProfile
};
