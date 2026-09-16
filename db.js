const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbDir = path.join(__dirname, 'data');
fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(path.join(dbDir, 'database.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  last_name TEXT NOT NULL,
  first_name TEXT NOT NULL,
  object TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  position TEXT NOT NULL DEFAULT '',
  login TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('superadmin','admin','employee')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title_ru TEXT NOT NULL,
  title_kz TEXT NOT NULL,
  description_ru TEXT DEFAULT '',
  description_kz TEXT DEFAULT '',
  material_pdf_path TEXT,
  video_url TEXT,
  time_limit_minutes INTEGER NOT NULL DEFAULT 20,
  pass_score_percent INTEGER NOT NULL DEFAULT 80,
  validity_months INTEGER NOT NULL DEFAULT 12,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  question_ru TEXT NOT NULL,
  question_kz TEXT NOT NULL,
  options_ru TEXT NOT NULL, -- JSON array of strings
  options_kz TEXT NOT NULL, -- JSON array of strings
  correct_index INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  protocol_number TEXT NOT NULL,
  protocol_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','passed','failed')),
  retake_allowed INTEGER NOT NULL DEFAULT 0,
  attempts_used INTEGER NOT NULL DEFAULT 0,
  score_percent INTEGER,
  focus_violations INTEGER NOT NULL DEFAULT 0,
  certificate_number TEXT,
  test_date TEXT,
  next_test_date TEXT,
  assigned_by INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  company_name TEXT DEFAULT 'ТОО «Компания»',
  chairman_name TEXT DEFAULT '',
  logo_path TEXT,
  stamp_path TEXT,
  signature_path TEXT
);
INSERT OR IGNORE INTO settings (id) VALUES (1);
`);

// Seed superadmin
const superLogin = process.env.SUPERADMIN_LOGIN || '8888';
const superPass = process.env.SUPERADMIN_PASSWORD || '88885555';
const existing = db.prepare('SELECT id FROM users WHERE login = ?').get(superLogin);
if (!existing) {
  const hash = bcrypt.hashSync(superPass, 10);
  db.prepare(`INSERT INTO users (last_name, first_name, object, department, position, login, password_hash, role)
              VALUES (?, ?, '', '', 'Суперадминистратор', ?, ?, 'superadmin')`)
    .run('Super', 'Admin', superLogin, hash);
  console.log(`[seed] Суперадмин создан: логин=${superLogin}`);
}

module.exports = db;
