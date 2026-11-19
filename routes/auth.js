const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { query, restoreExpiredLeaves } = require('../db');

const crypto = require('crypto');

// ===== Секрет для токенов входа =====
// Если JWT_SECRET на хостинге не задан, короткий или скопирован из примера (change_this_secret_in_production),
// любой, кто видел код, мог бы подделать вход суперадмина. В этом случае сайт сам создаёт длинный случайный
// секрет и хранит его в базе (settings.jwt_secret) — в файлах и в GitHub его нет. initAuthSecret() вызывается
// при запуске сервера (Server.js) до приёма запросов.
const WEAK_SECRETS = ['change_this_secret_in_production', 'secret', 'changeme', 'jwt_secret', 'your_secret'];
let JWT_SECRET = String(process.env.JWT_SECRET || '');
const ENV_SECRET_WEAK = JWT_SECRET.length < 32 || WEAK_SECRETS.includes(JWT_SECRET.toLowerCase());
async function initAuthSecret() {
  if (!ENV_SECRET_WEAK) return;
  await query('ALTER TABLE settings ADD COLUMN IF NOT EXISTS jwt_secret TEXT');
  const r = await query('SELECT jwt_secret FROM settings WHERE id = 1');
  let sec = r.rows[0] && r.rows[0].jwt_secret;
  if (!sec || sec.length < 64) {
    sec = crypto.randomBytes(48).toString('hex');
    await query('UPDATE settings SET jwt_secret = $1 WHERE id = 1', [sec]);
    console.warn('[auth] JWT_SECRET не задан или слабый — создан случайный секрет в базе. Все пользователи один раз войдут заново.');
  }
  JWT_SECRET = sec;
}

// Стандартные / слабые пароли, которые надо сменить (у суперадмина по умолчанию был 88885555)
const KNOWN_WEAK = ['88885555', '12345678', '123456789', '1234567890', 'password', 'qwerty123', '11111111', '00000000'];
function weakPasswordReason(pw, login) {
  const p = String(pw || '');
  if (p.length < 10) return 'Пароль должен быть не короче 10 символов';
  if (!/[a-zа-яё]/i.test(p) || !/\d/.test(p)) return 'Пароль должен содержать и буквы, и цифры';
  if (KNOWN_WEAK.includes(p.toLowerCase()) || (login && p.toLowerCase().includes(String(login).toLowerCase()))) return 'Пароль слишком простой или содержит логин';
  if (/^(.)\1+$/.test(p)) return 'Пароль слишком простой';
  return '';
}
const STAFF_ROLES = ['superadmin', 'admin', 'assistant'];

// ===== Блокировка перебора пароля к одной учётной записи =====
// 8 неверных паролей к одному логину за 15 минут → этот логин закрыт на 15 минут (с любого IP).
const LOCK_FAILS = 8, LOCK_MS = 15 * 60 * 1000;
const failsByLogin = new Map(); // login -> { count, first, until }
function loginLocked(login) {
  const f = failsByLogin.get(login);
  return f && f.until && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60000) : 0;
}
function loginFailed(login) {
  const now = Date.now();
  let f = failsByLogin.get(login);
  if (!f || now - f.first > LOCK_MS) f = { count: 0, first: now, until: 0 };
  f.count += 1;
  if (f.count >= LOCK_FAILS) { f.until = now + LOCK_MS; console.warn(`[auth] логин ${login} заблокирован на 15 мин после ${f.count} неверных паролей`); }
  failsByLogin.set(login, f);
}
setInterval(() => { const now = Date.now(); for (const [k, f] of failsByLogin) if ((!f.until || f.until < now) && now - f.first > LOCK_MS) failsByLogin.delete(k); }, 10 * 60 * 1000).unref();

function authRequired(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'unauthorized', message: 'Токен отсутствует' });

  jwt.verify(token, JWT_SECRET, async (err, user) => {
    if (err) return res.status(403).json({ error: 'forbidden', message: 'Недействительный токен' });
    req.user = user;
    // Зона доступа ассистента лежит в токене (живёт 12 ч). Если суперадмин изменил зону, отключил учётную запись или
    // сменил роль — токен об этом не знает, и ассистент видел бы старую зону / получал «вне зоны» до повторного входа.
    // Поэтому для ассистента зону и статус берём из БД на каждый запрос (для остальных ролей ничего не меняется).
    // После смены пароля старые входы (на других устройствах) больше не действуют
    if (user && STAFF_ROLES.includes(user.role)) {
      try {
        const r = await query('SELECT EXTRACT(EPOCH FROM password_changed_at) AS pc, active FROM users WHERE id = $1', [user.id]);
        const row = r.rows[0];
        if (!row || Number(row.active) === 0) return res.status(401).json({ error: 'unauthorized', message: 'Учётная запись отключена — войдите заново' });
        if (row.pc && user.iat && Number(user.iat) + 2 < Number(row.pc)) {
          return res.status(401).json({ error: 'unauthorized', message: 'Пароль был изменён — войдите заново' });
        }
      } catch (e) { console.error('authRequired: проверка смены пароля:', e.message); }
    }
    if (user && user.role === 'assistant') {
      try {
        const r = await query(
          `SELECT assistant_objects, assistant_departments, admin_functions, committee_role, active FROM users WHERE id = $1 AND role = 'assistant'`,
          [user.id]
        );
        const row = r.rows[0];
        if (!row || Number(row.active) === 0) {
          return res.status(403).json({ error: 'forbidden', message: 'Учётная запись ассистента отключена или изменена — войдите заново' });
        }
        req.user.assistant_objects = row.assistant_objects || [];
        req.user.assistant_departments = row.assistant_departments || [];
        req.user.admin_functions = row.admin_functions || [];
        req.user.committee_role = row.committee_role || null;
      } catch (e) {
        console.error('authRequired: не удалось обновить зону ассистента, беру из токена:', e.message);
      }
    }
    // Функции админа тоже берём из БД на каждый запрос: суперадмин изменил набор — действует сразу, без перелогина.
    if (user && user.role === 'admin') {
      try {
        const r = await query('SELECT admin_functions FROM users WHERE id = $1', [user.id]);
        if (r.rows[0]) req.user.admin_functions = r.rows[0].admin_functions || [];
      } catch (e) {
        console.error('authRequired: не удалось обновить функции админа, беру из токена:', e.message);
      }
    }
    next();
  });
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'forbidden_role', message: 'Недостаточно прав' });
    }
    next();
  };
}

// POST /api/auth/login
// Защита входа от перебора паролей. Лимит щедрый: на объекте вся группа может входить с одного IP (общий Wi-Fi).
const { createRateLimiter } = require('../lib/rateLimit');
const loginLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000, max: 100,
  message: 'Слишком много попыток входа. Подождите несколько минут и попробуйте снова.'
});

router.post('/login', loginLimiter, async (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) {
    return res.status(400).json({ error: 'missing_fields', message: 'Укажите логин и пароль' });
  }

  const lockMin = loginLocked(String(login));
  if (lockMin) {
    return res.status(429).json({ error: 'locked', message: `Слишком много неверных паролей. Вход для этого логина закрыт на ${lockMin} мин.` });
  }
  try {
    // сотрудник, у которого закончился отпуск, должен мочь войти сразу, не дожидаясь почасовой задачи
    await restoreExpiredLeaves();
    const result = await query('SELECT * FROM users WHERE login = $1 AND active = 1', [login]);
    const user = result.rows[0];

    if (!user || !user.password_hash) {
      loginFailed(String(login));
      return res.status(401).json({ error: 'invalid_credentials', message: 'Неверный логин или пароль' });
    }

    const valid = bcrypt.compareSync(String(password), user.password_hash);
    if (!valid) {
      loginFailed(String(login));
      return res.status(401).json({ error: 'invalid_credentials', message: 'Неверный логин или пароль' });
    }
    failsByLogin.delete(String(login));
    // Суперадмин / админ / ассистент со слабым или стандартным паролем — сайт попросит сменить
    const mustChange = STAFF_ROLES.includes(user.role) && !!weakPasswordReason(password, user.login);

    // committee_role — роль в комиссии по проверке знаний (модуль электронного
    // подписания протоколов, см. routes/signatures.js, routes/protocols.js).
    // Кладём и в токен (фронтенду — чтобы показать пункт «Электронная подпись»
    // без лишнего запроса), и в ответ логина; сами операции подписания/сохранения
    // подписи на сервере всегда перепроверяют актуальное значение из БД, а не токена.
    const token = jwt.sign(
      {
        id: user.id,
        login: user.login,
        role: user.role,
        last_name: user.last_name,
        first_name: user.first_name,
        object: user.object,
        department: user.department,
        position: user.position,
        committee_role: user.committee_role || null,
        // Зона видимости роли "ассистент" (ТЗ: роли/ИИН/PDF=копия Word, §4/§9) — кладём
        // в токен, чтобы фронтенд сразу показал правильную зону без лишнего запроса.
        // Сами эндпоинты всё равно перепроверяют req.user.role/зону на каждый запрос.
        assistant_objects: user.assistant_objects || [],
        assistant_departments: user.assistant_departments || [],
        admin_functions: user.admin_functions || []
      },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        login: user.login,
        role: user.role,
        last_name: user.last_name,
        first_name: user.first_name,
        object: user.object,
        department: user.department,
        position: user.position,
        committee_role: user.committee_role || null,
        assistant_objects: user.assistant_objects || [],
        assistant_departments: user.assistant_departments || [],
        admin_functions: user.admin_functions || [],
        must_change_password: mustChange
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'server_error', details: err.message });
  }
});

// GET /api/auth/me — актуальные роль и функции текущего пользователя из БД.
// Фронтенд зовёт его при загрузке страницы, чтобы изменение функций админа суперадмином
// сработало без повторного входа (в localStorage лежит снимок на момент логина).
router.get('/me', authRequired, async (req, res) => {
  try {
    const r = await query('SELECT id, role, active, admin_functions FROM users WHERE id = $1', [req.user.id]);
    const row = r.rows[0];
    if (!row || Number(row.active) === 0) return res.status(403).json({ error: 'forbidden', message: 'Учётная запись отключена' });
    res.json({ id: row.id, role: row.role, admin_functions: row.admin_functions || [] });
  } catch (err) {
    res.status(500).json({ error: 'server_error', details: err.message });
  }
});

// POST /api/auth/change-password — сменить свой пароль { current_password, new_password }.
// Пароль хранится только как bcrypt-хэш (его нельзя прочитать обратно ни в базе, ни в файлах).
// После смены все прежние входы на других устройствах закрываются; текущему — выдаём новый токен.
router.post('/change-password', authRequired, async (req, res) => {
  try {
    const { current_password, new_password } = req.body || {};
    const r = await query('SELECT * FROM users WHERE id = $1 AND active = 1', [req.user.id]);
    const u = r.rows[0];
    if (!u) return res.status(404).json({ error: 'not_found' });
    if (!current_password || !u.password_hash || !bcrypt.compareSync(String(current_password), u.password_hash)) {
      loginFailed(String(u.login));
      return res.status(400).json({ error: 'invalid_password', message: 'Текущий пароль введён неверно' });
    }
    const weak = weakPasswordReason(new_password, u.login);
    if (weak) return res.status(400).json({ error: 'weak_password', message: weak });
    if (String(new_password) === String(current_password)) return res.status(400).json({ error: 'same_password', message: 'Новый пароль совпадает со старым' });
    await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ');
    await query('UPDATE users SET password_hash = $2, password_changed_at = NOW() WHERE id = $1', [u.id, bcrypt.hashSync(String(new_password), 12)]);
    try { await require('../lib/audit').logAction(req, 'password_changed', { entityType: 'user', entityId: u.id, entityName: `${u.last_name || ''} ${u.first_name || ''}`.trim() }); } catch (e) { /* журнал не обязателен */ }
    // новый токен (выдан после смены — проходит проверку password_changed_at)
    await new Promise((ok) => setTimeout(ok, 2100));
    const token = jwt.sign({
      id: u.id, login: u.login, role: u.role, last_name: u.last_name, first_name: u.first_name,
      object: u.object, department: u.department, position: u.position, committee_role: u.committee_role || null,
      assistant_objects: u.assistant_objects || [], assistant_departments: u.assistant_departments || [], admin_functions: u.admin_functions || []
    }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ ok: true, token });
  } catch (e) {
    res.status(500).json({ error: 'server_error', details: e.message });
  }
});

module.exports = {
  router,
  authRequired,
  requireRole,
  initAuthSecret
};
