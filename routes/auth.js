const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { query, restoreExpiredLeaves } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET не задана в переменных окружения!');
}

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
    if (user && user.role === 'assistant') {
      try {
        const r = await query(
          `SELECT assistant_objects, assistant_departments, active FROM users WHERE id = $1 AND role = 'assistant'`,
          [user.id]
        );
        const row = r.rows[0];
        if (!row || Number(row.active) === 0) {
          return res.status(403).json({ error: 'forbidden', message: 'Учётная запись ассистента отключена или изменена — войдите заново' });
        }
        req.user.assistant_objects = row.assistant_objects || [];
        req.user.assistant_departments = row.assistant_departments || [];
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
router.post('/login', async (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) {
    return res.status(400).json({ error: 'missing_fields', message: 'Укажите логин и пароль' });
  }

  try {
    // сотрудник, у которого закончился отпуск, должен мочь войти сразу, не дожидаясь почасовой задачи
    await restoreExpiredLeaves();
    const result = await query('SELECT * FROM users WHERE login = $1 AND active = 1', [login]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'invalid_credentials', message: 'Неверный логин или пароль' });
    }

    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'invalid_credentials', message: 'Неверный логин или пароль' });
    }

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
        admin_functions: user.admin_functions || []
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

module.exports = {
  router,
  authRequired,
  requireRole
};
