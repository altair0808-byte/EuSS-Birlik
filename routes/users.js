const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const { query, pool } = require('../db');
const { authRequired, requireRole } = require('./auth');
const { makeUploader } = require('../upload');

const upload = makeUploader('imports');

// List users (суперадмин скрыт из списка)
router.get('/', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { object, department, role, q } = req.query;
    let sql = `SELECT id, last_name, first_name, object, department, position, login, role, active, created_at
               FROM users WHERE role != 'superadmin'`;
    const params = [];
    if (object) { params.push(object); sql += ` AND object = $${params.length}`; }
    if (department) { params.push(department); sql += ` AND department = $${params.length}`; }
    if (role && role !== 'superadmin') { params.push(role); sql += ` AND role = $${params.length}`; }
    if (q) {
      params.push(`%${q}%`);
      sql += ` AND (last_name ILIKE $${params.length} OR first_name ILIKE $${params.length} OR login ILIKE $${params.length})`;
    }
    sql += ' ORDER BY last_name, first_name';
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (e) {
    console.error('Error fetching users:', e);
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Bulk import from Excel
// Expected columns (header row, any order): Фамилия, Имя, Объект, Отдел, Должность, Логин, Пароль
router.post('/import', authRequired, requireRole('admin', 'superadmin'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });

  const headerMap = {
    'фамилия': 'last_name',
    'имя': 'first_name',
    'объект': 'object',
    'отдел': 'department',
    'подразделение': 'department',
    'должность': 'position',
    'логин': 'login',
    'табельный номер': 'login',
    'пароль': 'password'
  };

  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(req.file.path);
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ error: 'empty_file' });

    const headerRow = ws.getRow(1);
    const colByField = {};
    headerRow.eachCell((cell, colNumber) => {
      const key = String(cell.value || '').trim().toLowerCase();
      if (headerMap[key]) colByField[headerMap[key]] = colNumber;
    });
    if (!colByField.last_name || !colByField.first_name || !colByField.login) {
      return res.status(400).json({ error: 'missing_columns', message: 'В файле должны быть колонки: Фамилия, Имя, Логин (и опционально Объект, Отдел, Должность, Пароль)' });
    }

    let created = 0, skipped = 0;
    const errors = [];

    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const get = (field) => colByField[field] ? String(row.getCell(colByField[field]).value || '').trim() : '';
      const last_name = get('last_name');
      const first_name = get('first_name');
      const login = get('login');
      if (!last_name && !first_name && !login) continue; // blank row

      if (!last_name || !first_name || !login) {
        errors.push(`Строка ${r}: не заполнены обязательные поля`);
        skipped++;
        continue;
      }

      const exists = await query('SELECT id FROM users WHERE login = $1', [login]);
      if (exists.rows.length > 0) {
        errors.push(`Строка ${r}: логин "${login}" уже занят`);
        skipped++;
        continue;
      }

      const password = get('password') || Math.random().toString(36).slice(-8);
      const hash = bcrypt.hashSync(password, 10);
      await query(
        `INSERT INTO users (last_name, first_name, object, department, position, login, password_hash, role)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'employee')`,
        [last_name, first_name, get('object'), get('department'), get('position'), login, hash]
      );
      created++;
    }

    res.json({ created, skipped, errors });
  } catch (e) {
    console.error('Error importing users:', e);
    res.status(500).json({ error: 'import_failed', details: e.message });
  }
});

// Meta
router.get('/meta/objects', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const objRes = await query(`SELECT DISTINCT object FROM users WHERE object != '' AND role != 'superadmin' ORDER BY object`);
    const depRes = await query(`SELECT DISTINCT department FROM users WHERE department != '' AND role != 'superadmin' ORDER BY department`);
    res.json({
      objects: objRes.rows.map(r => r.object),
      departments: depRes.rows.map(r => r.department)
    });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

function validateRole(requesterRole, targetRole) {
  if (requesterRole === 'admin') return targetRole === 'employee';
  if (requesterRole === 'superadmin') return ['admin', 'employee'].includes(targetRole);
  return false;
}

// Create single user
router.post('/', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  const { last_name, first_name, object, department, position, login, password, role } = req.body;
  const targetRole = role || 'employee';

  if (!validateRole(req.user.role, targetRole)) {
    return res.status(403).json({ error: 'forbidden_role', message: 'Недостаточно прав для назначения роли' });
  }
  if (!last_name || !first_name || !login || !password) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  try {
    const exists = await query('SELECT id FROM users WHERE login = $1', [login]);
    if (exists.rows.length > 0) return res.status(409).json({ error: 'login_taken' });

    const hash = bcrypt.hashSync(String(password), 10);
    const result = await query(
      `INSERT INTO users (last_name, first_name, object, department, position, login, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [last_name, first_name, object || '', department || '', position || '', login, hash, targetRole]
    );
    res.json({ id: result.rows[0].id });
  } catch (e) {
    console.error('Error creating user:', e);
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Update user
router.put('/:id', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  const id = Number(req.params.id);
  try {
    const targetRes = await query('SELECT * FROM users WHERE id = $1', [id]);
    const target = targetRes.rows[0];
    if (!target) return res.status(404).json({ error: 'not_found' });

    if (req.user.role === 'admin' && target.role !== 'employee') {
      return res.status(403).json({ error: 'forbidden', message: 'Администратор может редактировать только обычных сотрудников' });
    }

    const { last_name, first_name, object, department, position, login, password, active, role } = req.body;
    const fields = [];
    const params = [];

    if (role !== undefined) {
      if (req.user.role === 'admin' && role !== 'employee') {
        return res.status(403).json({ error: 'forbidden_role', message: 'Администратор не может назначать статус администратора' });
      }
      if (req.user.role === 'superadmin') {
        if (!['admin', 'employee'].includes(role)) {
          return res.status(400).json({ error: 'invalid_role' });
        }
        params.push(role);
        fields.push(`role = $${params.length}`);
      }
    }

    if (last_name !== undefined) { params.push(last_name); fields.push(`last_name = $${params.length}`); }
    if (first_name !== undefined) { params.push(first_name); fields.push(`first_name = $${params.length}`); }
    if (object !== undefined) { params.push(object); fields.push(`object = $${params.length}`); }
    if (department !== undefined) { params.push(department); fields.push(`department = $${params.length}`); }
    if (position !== undefined) { params.push(position); fields.push(`position = $${params.length}`); }
    if (login !== undefined) {
      const existing = await query('SELECT id FROM users WHERE login = $1 AND id != $2', [login, id]);
      if (existing.rows.length > 0) return res.status(409).json({ error: 'login_taken' });
      params.push(login);
      fields.push(`login = $${params.length}`);
    }
    if (active !== undefined) { params.push(active ? 1 : 0); fields.push(`active = $${params.length}`); }
    if (password) {
      params.push(bcrypt.hashSync(String(password), 10));
      fields.push(`password_hash = $${params.length}`);
    }

    if (fields.length === 0) return res.json({ ok: true });
    params.push(id);
    await query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${params.length}`, params);
    res.json({ ok: true });
  } catch (e) {
    console.error('Error updating user:', e);
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Delete user
router.delete('/:id', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  const id = Number(req.params.id);
  try {
    const targetRes = await query('SELECT * FROM users WHERE id = $1', [id]);
    const target = targetRes.rows[0];
    if (!target) return res.status(404).json({ error: 'not_found' });
    if (req.user.role === 'admin' && target.role !== 'employee') {
      return res.status(403).json({ error: 'forbidden' });
    }
    if (target.role === 'superadmin') {
      return res.status(403).json({ error: 'cannot_delete_superadmin' });
    }
    await query('DELETE FROM users WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Error deleting user:', e);
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

module.exports = router;
