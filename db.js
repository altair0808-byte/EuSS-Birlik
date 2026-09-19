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
  // Если таблица settings была создана ранее без колонки id, пересоздаем ее с правильной структурой
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'settings'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'settings' AND column_name = 'id'
      ) THEN
        DROP TABLE public.settings CASCADE;
      END IF;
    END $$;
  `);

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
      sort_order INT NOT NULL DEFAULT 0,
      variant_number INT NOT NULL DEFAULT 1
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
      member2_name TEXT DEFAULT '',
      member3_name TEXT DEFAULT '',
      logo_path TEXT,
      stamp_path TEXT,
      signature_path TEXT,
      protocol_prefix TEXT DEFAULT '',
      protocol_next_number INT DEFAULT 1,
      certificate_prefix TEXT DEFAULT '',
      certificate_digits INT DEFAULT 4,
      certificate_next_number INT DEFAULT 1
    );

    INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  `);

  // Миграции для существующих баз данных (на случай, если таблицы были созданы
  // более ранней версией схемы без этих колонок)
  await pool.query(`
    ALTER TABLE questions ADD COLUMN IF NOT EXISTS variant_number INT NOT NULL DEFAULT 1;
    ALTER TABLE courses ADD COLUMN IF NOT EXISTS video_path TEXT;
    ALTER TABLE assignments ADD COLUMN IF NOT EXISTS assigned_variant INT;
    CREATE INDEX IF NOT EXISTS idx_questions_course_variant ON questions(course_id, variant_number);

    -- Нумерация протоколов/сертификатов и 2 доп. члена комиссии (для БД,
    -- созданных более ранней версией схемы, где этих колонок ещё не было)
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS member2_name TEXT DEFAULT '';
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS member3_name TEXT DEFAULT '';
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS protocol_prefix TEXT DEFAULT '';
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS protocol_next_number INT DEFAULT 1;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS certificate_prefix TEXT DEFAULT '';
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS certificate_digits INT DEFAULT 4;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS certificate_next_number INT DEFAULT 1;
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
