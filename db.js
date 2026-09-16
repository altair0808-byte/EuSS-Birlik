const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('FATAL: DATABASE_URL не задана в переменных окружения!');
}

const pool = new Pool({
  connectionString,
  ssl: connectionString && connectionString.includes('localhost') ? false : { rejectUnauthorized: false }
});

// Хелпер для SQL запросов
async function query(text, params) {
  return pool.query(text, params);
}

// Инициализация структуры таблиц и создание суперадмина
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      last_name TEXT NOT NULL,
      first_name TEXT NOT NULL,
      object TEXT NOT NULL DEFAULT '',
      department TEXT NOT NULL DEFAULT '',
      position TEXT NOT NULL DEFAULT '',
      login TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('superadmin','admin','employee')),
      active SMALLINT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS courses (
      id BIGSERIAL PRIMARY KEY,
      title_ru TEXT NOT NULL,
      title_kz TEXT NOT NULL,
      description_ru TEXT DEFAULT '',
      description_kz TEXT DEFAULT '',
      material_pdf_path TEXT,
      video_url TEXT,
      time_limit_minutes INT NOT NULL DEFAULT 20,
      pass_score_percent INT NOT NULL DEFAULT 80,
      validity_months INT NOT NULL DEFAULT 12,
      created_by BIGINT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS questions (
      id BIGSERIAL PRIMARY KEY,
      course_id BIGINT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      question_ru TEXT NOT NULL,
      question_kz TEXT NOT NULL,
      options_ru TEXT NOT NULL,
      options_kz TEXT NOT NULL,
      correct_index INT NOT NULL,
      sort_order INT NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS assignments (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      course_id BIGINT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      protocol_number TEXT NOT NULL,
      protocol_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','passed','failed')),
      retake_allowed SMALLINT NOT NULL DEFAULT 0,
      attempts_used INT NOT NULL DEFAULT 0,
      score_percent INT,
      focus_violations INT NOT NULL DEFAULT 0,
      certificate_number TEXT,
      test_date TEXT,
      next_test_date TEXT,
      assigned_by BIGINT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INT PRIMARY KEY CHECK (id = 1),
      company_name TEXT DEFAULT 'ТОО «Компания»',
      chairman_name TEXT DEFAULT '',
      logo_path TEXT,
      stamp_path TEXT,
      signature_path TEXT
    );

    INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  `);

  // Создание учетной записи суперадмина
  const superLogin = process.env.SUPERADMIN_LOGIN || '8888';
  const superPass = process.env.SUPERADMIN_PASSWORD || '88885555';
  const existing = await pool.query('SELECT id FROM users WHERE login = $1', [superLogin]);
  if (existing.rows.length === 0) {
    const hash = bcrypt.hashSync(superPass, 10);
    await pool.query(
      `INSERT INTO users (last_name, first_name, object, department, position, login, password_hash, role)
       VALUES ($1, $2, '', '', 'Суперадминистратор', $3, $4, 'superadmin')`,
      ['Super', 'Admin', superLogin, hash]
    );
    console.log(`[seed] Суперадмин создан в Supabase: логин=${superLogin}`);
  }
}

module.exports = { pool, query, initDb };
