const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
require('dotenv').config();

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'tb-training-secret-key-2026';

// Middleware: проверка авторизации по JWT токену
function authRequired(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized', message: 'Токен отсутствует' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid_token', message: 'Недействительный или просроченный токен' });
  }
}

// Middleware: проверка роли пользователя
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'forbidden', message: 'Недостаточно прав доступа' });
    }
    next();
  };
}

router.post('/login', (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'missing_fields' });

  const user = db.prepare('SELECT * FROM users WHERE login = ? AND active = 1').get(login);
  if (!user) return res.status(401).json({ error: 'invalid_credentials' });

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

  const token = jwt.sign(
    { id: user.id, login: user.login, role: user.role, first_name: user.first_name, last_name: user.last_name },
    JWT_SECRET,
    { expiresIn: '12h' }
  );

  res.json({
    token,
    user: {
      id: user.id, login: user.login, role: user.role,
      first_name: user.first_name, last_name: user.last_name,
      object: user.object, department: user.department, position: user.position
    }
  });
});

module.exports = router;
module.exports.authRequired = authRequired;
module.exports.requireRole = requireRole;
