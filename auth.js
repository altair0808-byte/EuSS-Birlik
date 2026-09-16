const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { query } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'tb-training-secret-key-change-in-production';

function authRequired(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'unauthorized', message: 'Токен отсутствует' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'forbidden', message: 'Недействительный токен' });
    req.user = user;
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
    const result = await query('SELECT * FROM users WHERE login = $1 AND active = 1', [login]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'invalid_credentials', message: 'Неверный логин или пароль' });
    }

    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'invalid_credentials', message: 'Неверный логин или пароль' });
    }

    const token = jwt.sign(
      {
        id: user.id,
        login: user.login,
        role: user.role,
        last_name: user.last_name,
        first_name: user.first_name,
        object: user.object,
        department: user.department,
        position: user.position
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
        position: user.position
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'server_error', details: err.message });
  }
});

module.exports = {
  router,
  authRequired,
  requireRole
};
