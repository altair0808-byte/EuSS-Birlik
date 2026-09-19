import pg from 'pg';
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';

dotenv.config();

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

export const query = (text, params) => pool.query(text, params);

export async function initDb() {
  // Автоматические миграции для расширенного функционала
  await pool.query(`
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS logo_data TEXT;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS stamp_data TEXT;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS chairman1_name TEXT;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS chairman1_position TEXT;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS chairman1_signature TEXT;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS chairman2_name TEXT;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS chairman2_position TEXT;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS chairman2_signature TEXT;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS active_chairman INTEGER DEFAULT 1;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS protocol_year INTEGER DEFAULT EXTRACT(YEAR FROM CURRENT_DATE);
    ALTER TABLE assignments ADD COLUMN IF NOT EXISTS protocol_open_date DATE;
    ALTER TABLE assignments ADD COLUMN IF NOT EXISTS protocol_close_date DATE;
    ALTER TABLE assignments ADD COLUMN IF NOT EXISTS user_answers JSONB;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS permanent_certificate_number TEXT;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      iin VARCHAR(12) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL,
      middle_name VARCHAR(100),
      organization VARCHAR(255),
      department VARCHAR(255),
      position VARCHAR(255),
      role VARCHAR(50) DEFAULT 'employee',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS courses (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      total_questions INT DEFAULT 10,
      passing_score INT DEFAULT 70,
      time_limit_minutes INT DEFAULT 20,
      validity_period_years INT DEFAULT 1,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS questions (
      id SERIAL PRIMARY KEY,
      course_id INT REFERENCES courses(id) ON DELETE CASCADE,
      question_text TEXT NOT NULL,
      options JSONB NOT NULL,
      correct_option_index INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS assignments (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      course_id INT REFERENCES courses(id) ON DELETE CASCADE,
      assigned_by INT REFERENCES users(id),
      status VARCHAR(50) DEFAULT 'pending',
      score_percent INT,
      test_date TIMESTAMP,
      next_test_date DATE,
      protocol_number VARCHAR(100),
      protocol_date DATE,
      certificate_number VARCHAR(100),
      violations_count INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      id SERIAL PRIMARY KEY,
      company_name VARCHAR(255),
      bin VARCHAR(12),
      training_center_name VARCHAR(255),
      training_center_address TEXT,
      license_info TEXT,
      chairman_name VARCHAR(255),
      chairman_position VARCHAR(255),
      chairman_signature_url TEXT,
      member1_name VARCHAR(255),
      member1_position VARCHAR(255),
      member2_name VARCHAR(255),
      member2_position VARCHAR(255),
      member3_name VARCHAR(255),
      member3_position VARCHAR(255),
      logo_url TEXT,
      stamp_url TEXT,
      protocol_prefix VARCHAR(50) DEFAULT '',
      protocol_next_number INT DEFAULT 1,
      cert_prefix VARCHAR(50) DEFAULT 'CERT-',
      cert_next_number INT DEFAULT 1001,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const usersCount = await pool.query('SELECT COUNT(*) FROM users');
  if (parseInt(usersCount.rows[0].count, 10) === 0) {
    const defaultPassword = 'admin';
    const hash = await bcrypt.hash(defaultPassword, 10);
    await pool.query(`
      INSERT INTO users (iin, password_hash, first_name, last_name, role)
      VALUES ($1, $2, $3, $4, $5)
    `, ['000000000000', hash, 'Super', 'Admin', 'super_admin']);
    console.log('Создан дефолтный супер-администратор (ИИН: 000000000000, Пароль: admin)');
  }

  const settingsCount = await pool.query('SELECT COUNT(*) FROM settings');
  if (parseInt(settingsCount.rows[0].count, 10) === 0) {
    await pool.query(`
      INSERT INTO settings (id, company_name, chairman_name, active_chairman)
      VALUES (1, 'ТОО "EuSS-Birlik"', 'Иванов И.И.', 1)
    `);
  }
}
