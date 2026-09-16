const express = require('express');
const router = express.Router();
const db = require('../db');
const { authRequired, requireRole } = require('./auth'); // <-- ВОТ ЭТА СТРОКА
const { makeUploader } = require('../upload');

// List users (admin/superadmin only), with optional filters
router.get('/', authRequired, requireRole('admin', 'superadmin'), (req, res) => {
  const { object, department, role, q } = req.query;
  let sql = `SELECT id, last_name, first_name, object, department, position, login, role, active, created_at
             FROM users WHERE 1=1`;
  const params = [];
  if (object) { sql += ' AND object = ?'; params.push(object); }
  if (department) { sql += ' AND department = ?'; params.push(department); }
  if (role) { sql += ' AND role = ?'; params.push(role); }
  if (q) {
    sql += ' AND (last_name LIKE ? OR first_name LIKE ? OR login LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  sql += ' ORDER BY last_name, first_name';
  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// Distinct objects/departments (for filters/dropdowns)
router.get('/meta/objects', authRequired, requireRole('admin', 'superadmin'), (req, res) => {
  const objects = db.prepare(`SELECT DISTINCT object FROM users WHERE object != '' ORDER BY object`).all().map(r => r.object);
  const departments = db.prepare(`SELECT DISTINCT department FROM users WHERE department != '' ORDER BY department`).all().map(r => r.department);
  res.json({ objects, departments });
});

function validateRole(requesterRole, targetRole) {
  // Only superadmin can create admins/superadmins. Admin can only create employees.
  if (requesterRole === 'superadmin') return true;
  if (requesterRole === 'admin' && targetRole === 'employee') return true;
  return false;
}

// Create single user
router.post('/', authRequired, requireRole('admin', 'superadmin'), (req, res) => {
  const { last_name, first_name, object, department, position, login, password, role } = req.body;
  const targetRole = role || 'employee';
  if (!validateRole(req.user.role, targetRole)) return res.status(403).json({ error: 'forbidden_role' });
  if (!last_name || !first_name || !login || !password) return res.status(400).json({ error: 'missing_fields' });

  const exists = db.prepare('SELECT id FROM users WHERE login = ?').get(login);
  if (exists) return res.status(409).json({ error: 'login_taken' });

  const hash = bcrypt.hashSync(String(password), 10);
  const info = db.prepare(`INSERT INTO users (last_name, first_name, object, department, position, login, password_hash, role)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(last_name, first_name, object || '', department || '', position || '', login, hash, targetRole);
  res.json({ id: info.lastInsertRowid });
});

// Update user
router.put('/:id', authRequired, requireRole('admin', 'superadmin'), (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'not_found' });
  if (req.user.role === 'admin' && target.role !== 'employee') return res.status(403).json({ error: 'forbidden' });

  const { last_name, first_name, object, department, position, login, password, active } = req.body;
  const fields = [];
  const params = [];
  if (last_name !== undefined) { fields.push('last_name = ?'); params.push(last_name); }
  if (first_name !== undefined) { fields.push('first_name = ?'); params.push(first_name); }
  if (object !== undefined) { fields.push('object = ?'); params.push(object); }
  if (department !== undefined) { fields.push('department = ?'); params.push(department); }
  if (position !== undefined) { fields.push('position = ?'); params.push(position); }
  if (login !== undefined) { fields.push('login = ?'); params.push(login); }
  if (active !== undefined) { fields.push('active = ?'); params.push(active ? 1 : 0); }
  if (password) { fields.push('password_hash = ?'); params.push(bcrypt.hashSync(String(password), 10)); }
  if (fields.length === 0) return res.json({ ok: true });
  params.push(id);
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

// Delete user
router.delete('/:id', authRequired, requireRole('admin', 'superadmin'), (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'not_found' });
  if (req.user.role === 'admin' && target.role !== 'employee') return res.status(403).json({ error: 'forbidden' });
  if (target.role === 'superadmin') return res.status(403).json({ error: 'cannot_delete_superadmin' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

// Bulk import from Excel
// Expected columns (header row, RU): Фамилия | Имя | Объект | Отдел | Должность | Логин | Пароль | Роль(optional)
router.post('/import', authRequired, requireRole('admin', 'superadmin'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(req.file.path);
    const ws = wb.worksheets[0];
    const headerRow = ws.getRow(1).values.map(v => (v || '').toString().trim().toLowerCase());

    const colIndex = (names) => headerRow.findIndex(h => names.includes(h));
    const idx = {
      last_name: colIndex(['фамилия']),
      first_name: colIndex(['имя']),
      object: colIndex(['объект']),
      department: colIndex(['отдел', 'департамент', 'цех']),
      position: colIndex(['должность', 'профессия']),
      login: colIndex(['логин']),
      password: colIndex(['пароль']),
      role: colIndex(['роль'])
    };
    if (idx.last_name < 0 || idx.first_name < 0 || idx.login < 0 || idx.password < 0) {
      return res.status(400).json({ error: 'bad_headers', message: 'Ожидаются колонки: Фамилия, Имя, Объект, Отдел, Должность, Логин, Пароль' });
    }

    let created = 0, updated = 0, errors = [];
    const insertStmt = db.prepare(`INSERT INTO users (last_name, first_name, object, department, position, login, password_hash, role)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const updateStmt = db.prepare(`UPDATE users SET last_name=?, first_name=?, object=?, department=?, position=?, password_hash=? WHERE login=?`);
    const findStmt = db.prepare('SELECT id FROM users WHERE login = ?');

    const rows = ws.getRows(2, ws.rowCount - 1) || [];
    const tx = db.transaction(() => {
      for (const row of rows) {
        const vals = row.values;
        const last_name = (vals[idx.last_name] || '').toString().trim();
        const first_name = (vals[idx.first_name] || '').toString().trim();
        if (!last_name || !first_name) continue;
        const object = idx.object >= 0 ? (vals[idx.object] || '').toString().trim() : '';
        const department = idx.department >= 0 ? (vals[idx.department] || '').toString().trim() : '';
        const position = idx.position >= 0 ? (vals[idx.position] || '').toString().trim() : '';
        const login = (vals[idx.login] || '').toString().trim();
        const password = (vals[idx.password] || '').toString().trim();
        const role = idx.role >= 0 ? ((vals[idx.role] || '').toString().trim().toLowerCase() || 'employee') : 'employee';
        const safeRole = ['admin', 'employee'].includes(role) ? role : 'employee';
        if (!login || !password) { errors.push(`${last_name} ${first_name}: нет логина/пароля`); continue; }
        if (req.user.role === 'admin' && safeRole !== 'employee') { errors.push(`${last_name} ${first_name}: недостаточно прав для роли ${safeRole}`); continue; }

        const existing = findStmt.get(login);
        const hash = bcrypt.hashSync(password, 10);
        if (existing) {
          updateStmt.run(last_name, first_name, object, department, position, hash, login);
          updated++;
        } else {
          insertStmt.run(last_name, first_name, object, department, position, login, hash, safeRole);
          created++;
        }
      }
    });
    tx();

    res.json({ created, updated, errors });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'import_failed', message: e.message });
  }
});

module.exports = router;
