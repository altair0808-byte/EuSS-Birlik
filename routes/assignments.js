const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { query, pool } = require('../db');
const { authRequired, requireRole } = require('./auth');
const { makeUploader } = require('../upload');
const { findActiveProtocol, nextProtocolNumber } = require('./protocols');
const { splitMulti } = require('../lib/multiFilter');

const uploadImport = makeUploader('imports');

// Экранирует спецсимволы регулярных выражений и LIKE-паттернов в префиксе
// сертификата, чтобы его можно было безопасно подставить в SQL-запрос.
function escapeForRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function escapeForLike(str) {
  return String(str || '').replace(/[%_\\]/g, '\\$&');
}

// Номер сертификата сотрудника (п.1 запроса): по умолчанию равен его логину (табельному
// номеру) — сотрудник видит на сертификате тот же номер, под которым он входит в систему.
// Если у сотрудника вручную задан «№ сертификата» в карточке (permanent_certificate_number) —
// он имеет приоритет (осознанный ручной override, как было раньше). Если логина нет —
// присваивается следующий свободный номер по общей нумерации (как раньше, getNextCertNumber).
async function getCertNumberForUser(userId) {
  const uRes = await query('SELECT login, permanent_certificate_number FROM users WHERE id = $1', [userId]);
  const u = uRes.rows[0];
  if (u && u.permanent_certificate_number) return u.permanent_certificate_number;
  if (u && u.login) return u.login;
  return getNextCertNumber();
}

// Независимая нумерация сертификатов (п.7 запроса): без сброса (в т.ч. по
// году) и без повторного использования номеров, даже если сотрудник удалён
// или перемещён. Формат (префикс + количество цифр) настраивается в
// settings, а следующий номер — не просто счётчик в settings, а
// GREATEST(счётчик в settings, реальный максимум уже выданных номеров + 1).
// Это защищает от коллизий, когда номер сертификата был внесён вручную —
// при импорте, в исторической записи или в карточке сотрудника
// (permanent_certificate_number) — и не совпадает со значением счётчика.
// Выполняется в транзакции с блокировкой строки settings (FOR UPDATE),
// чтобы параллельные запросы не получили один и тот же номер.
async function getNextCertNumber() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sRes = await client.query(
      `SELECT certificate_prefix, certificate_digits, certificate_next_number
       FROM settings WHERE id = 1 FOR UPDATE`
    );
    const s = sRes.rows[0] || {};
    const prefix = s.certificate_prefix || '';
    const digits = s.certificate_digits || 4;
    const likePattern = escapeForLike(prefix) + '%';
    const regexPattern = '^' + escapeForRegex(prefix) + '(\\d+)$';

    const maxRes = await client.query(
      `SELECT COALESCE(MAX(num), 0) AS max_num FROM (
         SELECT NULLIF(regexp_replace(certificate_number, $2, '\\1'), certificate_number)::bigint AS num
         FROM assignments WHERE certificate_number LIKE $1 ESCAPE '\\'
         UNION ALL
         SELECT NULLIF(regexp_replace(permanent_certificate_number, $2, '\\1'), permanent_certificate_number)::bigint AS num
         FROM users WHERE permanent_certificate_number LIKE $1 ESCAPE '\\'
       ) t WHERE num IS NOT NULL`,
      [likePattern, regexPattern]
    );
    const maxUsed = Number(maxRes.rows[0]?.max_num || 0);
    const nextVal = Math.max(Number(s.certificate_next_number || 1), maxUsed + 1);

    await client.query('UPDATE settings SET certificate_next_number = $1 WHERE id = 1', [nextVal + 1]);
    await client.query('COMMIT');
    return `${prefix}${String(nextVal).padStart(digits, '0')}`;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Номер протокола больше не хранится в настройках: подсказка берётся из вкладки «Протоколы» —
// если сегодня действует открытый протокол, предлагаем его номер, иначе — следующий по
// нумерации текущего года (см. nextProtocolNumber в routes/protocols.js).
async function peekNextProtocolNumber() {
  const active = await findActiveProtocol(new Date().toISOString().slice(0, 10));
  if (active) return String(active.protocol_number);
  return nextProtocolNumber(new Date().getFullYear());
}

// Last numbers
router.get('/last-numbers', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const nextProtocol = await peekNextProtocolNumber();
    const sRes = await query('SELECT certificate_prefix, certificate_digits, certificate_next_number FROM settings WHERE id = 1');
    const s = sRes.rows[0] || {};
    const nextCert = `${s.certificate_prefix || ''}${String(s.certificate_next_number || 1).padStart(s.certificate_digits || 4, '0')}`;
    res.json({
      next_protocol_number: nextProtocol,
      next_certificate_number: nextCert
    });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Заполняет недостающие исторические поля (дату следующего прохождения, номер
// сертификата), когда админ вносит уже пройденное ранее (до внедрения системы)
// обучение сотрудника, а не создаёт новое назначение теста.
async function buildHistoricalFields(course_id, hist, userId) {
  const cRes = await query('SELECT validity_months, no_expiry FROM courses WHERE id = $1', [course_id]);
  const validityMonths = cRes.rows[0]?.validity_months || 12;
  const noExpiry = !!cRes.rows[0]?.no_expiry;

  const testDate = hist.test_date;
  let nextTestDate = noExpiry ? null : hist.next_test_date;   // бессрочный курс: даты следующего прохождения нет
  if (!noExpiry && !nextTestDate && testDate) {
    const d = new Date(testDate);
    d.setMonth(d.getMonth() + validityMonths);
    nextTestDate = d.toISOString();
  }
  let certNumber = hist.certificate_number;
  if (!certNumber) certNumber = userId ? await getCertNumberForUser(userId) : await getNextCertNumber();

  return {
    status: 'passed',
    score_percent: hist.score_percent !== undefined && hist.score_percent !== null && hist.score_percent !== ''
      ? Number(hist.score_percent) : 100,
    test_date: testDate,
    next_test_date: nextTestDate,
    certificate_number: certNumber
  };
}

// Create assignment
router.post('/', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  const { user_id, course_id, protocol_number, protocol_date, historical, test_date, next_test_date, certificate_number, score_percent } = req.body;
  if (!user_id || !course_id || !protocol_number || !protocol_date) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  if (historical && !test_date) {
    return res.status(400).json({ error: 'missing_fields', message: 'Для исторической записи укажите дату прохождения' });
  }

  try {
    // Курсы назначаются только сотрудникам — администраторы в обучении и статистике не участвуют
    const roleRes = await query('SELECT role FROM users WHERE id = $1', [user_id]);
    if (!roleRes.rows[0] || roleRes.rows[0].role !== 'employee') {
      return res.status(400).json({ error: 'not_employee', message: 'Курсы можно назначать только сотрудникам' });
    }
    if (historical) {
      const h = await buildHistoricalFields(course_id, { test_date, next_test_date, certificate_number, score_percent }, user_id);
      const result = await query(`
        INSERT INTO assignments (user_id, course_id, protocol_number, protocol_date, assigned_by,
          status, score_percent, test_date, next_test_date, certificate_number)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id
      `, [user_id, course_id, protocol_number, protocol_date, req.user.id,
          h.status, h.score_percent, h.test_date, h.next_test_date, h.certificate_number]);
      return res.json({ id: result.rows[0].id });
    }

    const result = await query(`
      INSERT INTO assignments (user_id, course_id, protocol_number, protocol_date, assigned_by)
      VALUES ($1, $2, $3, $4, $5) RETURNING id
    `, [user_id, course_id, protocol_number, protocol_date, req.user.id]);
    res.json({ id: result.rows[0].id });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Bulk create assignments — один протокол/курс/дата на группу сотрудников сразу.
// Один и тот же protocol_number намеренно проставляется всем строкам: на практике
// один протокол комиссии обычно покрывает сразу нескольких проверяемых сотрудников.
// historical=true — внесение уже пройденного ранее обучения (старые данные сотрудников),
// без прохождения теста в системе: сразу проставляется статус "passed".
router.post('/bulk', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  const { user_ids, course_id, protocol_number, protocol_date, historical, test_date, next_test_date, score_percent } = req.body;

  if (!Array.isArray(user_ids) || user_ids.length === 0 || !course_id || !protocol_number || !protocol_date) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  if (historical && !test_date) {
    return res.status(400).json({ error: 'missing_fields', message: 'Для исторической записи укажите дату прохождения' });
  }

  // На всякий случай убираем дубликаты id, которые мог прислать фронт
  const uniqueUserIds = [...new Set(user_ids.map(Number))].filter(Number.isFinite);
  if (uniqueUserIds.length === 0) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Проверяем, что все переданные id существуют в базе (исключая суперадмина)
    const checkRes = await client.query(
      `SELECT id FROM users WHERE id = ANY($1::bigint[]) AND role = 'employee'`,
      [uniqueUserIds]
    );
    // Приводим id из базы к Number, чтобы совпадало с типами в uniqueUserIds
    const validIds = new Set(checkRes.rows.map(r => Number(r.id)));
    const skippedIds = uniqueUserIds.filter(id => !validIds.has(id));

    const createdIds = [];
    for (const userId of uniqueUserIds) {
      if (!validIds.has(userId)) continue;
      if (historical) {
        // Каждому сотруднику отдельный номер сертификата (getNextCertNumber читает
        // максимум из БД на каждый вызов — работает корректно и в цикле).
        const h = await buildHistoricalFields(course_id, { test_date, next_test_date, score_percent }, userId);
        const result = await client.query(`
          INSERT INTO assignments (user_id, course_id, protocol_number, protocol_date, assigned_by,
            status, score_percent, test_date, next_test_date, certificate_number)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id
        `, [userId, course_id, protocol_number, protocol_date, req.user.id,
            h.status, h.score_percent, h.test_date, h.next_test_date, h.certificate_number]);
        createdIds.push(result.rows[0].id);
        continue;
      }
      const result = await client.query(`
        INSERT INTO assignments (user_id, course_id, protocol_number, protocol_date, assigned_by)
        VALUES ($1, $2, $3, $4, $5) RETURNING id
      `, [userId, course_id, protocol_number, protocol_date, req.user.id]);
      createdIds.push(result.rows[0].id);
    }

    await client.query('COMMIT');
    res.json({ created: createdIds.length, ids: createdIds, skipped: skippedIds.length });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'db_error', details: e.message });
  } finally {
    client.release();
  }
});

// Employee's own assignments
router.get('/mine', authRequired, async (req, res) => {
  try {
    const result = await query(`
      SELECT a.*, c.title_ru, c.title_kz, c.category_ru, c.category_kz, c.no_expiry, c.time_limit_minutes, c.pass_score_percent,
             c.material_pdf_path, c.video_url, c.video_path, c.description_ru, c.description_kz,
             c.material_pdf_path_ru, c.material_pdf_path_kz,
             c.video_path_ru, c.video_path_kz, c.video_url_ru, c.video_url_kz
      FROM assignments a
      JOIN courses c ON c.id = a.course_id
      WHERE a.user_id = $1
      ORDER BY a.created_at DESC
    `, [req.user.id]);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// List all assignments
router.get('/', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { status, user_id, course_id, object, department, q, date_from, date_to, active_only } = req.query;
    let sql = `
      SELECT a.*, u.last_name, u.first_name, u.object, u.department, u.position,
             c.title_ru, c.title_kz, c.category_ru, c.category_kz, c.no_expiry, c.pass_score_percent
      FROM assignments a
      JOIN users u ON u.id = a.user_id
      JOIN courses c ON c.id = a.course_id
      WHERE u.role = 'employee'
    `;
    const params = [];
    // active_only=1 — используется сводкой на главной странице (карточки/статистика), чтобы
    // уволенные и сотрудники в декрете туда не попадали. Сама вкладка «Назначения» (журнал)
    // не фильтруется по умолчанию — это архивный журнал, в нём записи должны оставаться видимыми.
    if (active_only) sql += ` AND u.active = 1`;
    if (status) { params.push(status); sql += ` AND a.status = $${params.length}`; }
    if (user_id) { params.push(user_id); sql += ` AND a.user_id = $${params.length}`; }
    if (course_id) { params.push(course_id); sql += ` AND a.course_id = $${params.length}`; }
    const objects = splitMulti(object);
    const departments = splitMulti(department);
    if (objects.length) { params.push(objects); sql += ` AND u.object = ANY($${params.length}::text[])`; }
    if (departments.length) { params.push(departments); sql += ` AND u.department = ANY($${params.length}::text[])`; }
    if (q) {
      params.push(`%${q}%`);
      sql += ` AND (u.last_name ILIKE $${params.length} OR u.first_name ILIKE $${params.length} OR u.login ILIKE $${params.length})`;
    }
    // Дата прохождения теста (test_date) — используется для журнала по датам и календаря
    if (date_from) { params.push(date_from); sql += ` AND a.test_date >= $${params.length}`; }
    if (date_to) { params.push(date_to + 'T23:59:59.999Z'); sql += ` AND a.test_date <= $${params.length}`; }
    sql += ' ORDER BY a.created_at DESC';

    const result = await query(sql, params);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Assignments whose certificate is expiring soon (or already expired) — for admin dashboard widget
router.get('/expiring', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const days = Number(req.query.days) || 30;
    const { object, department } = req.query;
    const params = [String(days)];
    let orgSql = '';
    const objects = splitMulti(object);
    const departments = splitMulti(department);
    if (objects.length) { params.push(objects); orgSql += ` AND u.object = ANY($${params.length}::text[])`; }
    if (departments.length) { params.push(departments); orgSql += ` AND u.department = ANY($${params.length}::text[])`; }
    const result = await query(`
      SELECT a.*, u.last_name, u.first_name, u.object, u.department, u.position, u.login,
             c.title_ru, c.title_kz, c.category_ru, c.category_kz
      FROM assignments a
      JOIN users u ON u.id = a.user_id
      JOIN courses c ON c.id = a.course_id
      WHERE u.role = 'employee'
        AND u.active = 1
        AND a.status = 'passed'
        AND a.next_test_date IS NOT NULL
        AND c.no_expiry = FALSE
        AND a.next_test_date::timestamptz <= NOW() + ($1 || ' days')::interval
        AND NOT EXISTS (
          SELECT 1 FROM assignments n
          WHERE n.user_id = a.user_id AND n.course_id = a.course_id AND n.status = 'passed'
            AND (COALESCE(n.test_date, '') > COALESCE(a.test_date, '')
                 OR (COALESCE(n.test_date, '') = COALESCE(a.test_date, '') AND n.id > a.id))
        )
        ${orgSql}
      ORDER BY a.next_test_date::timestamptz ASC
    `, params);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Список всех выданных сертификатов (вкладка «Сертификаты» рядом с «Протоколами», п.7 запроса).
// Показывает номер, сотрудника, курс, дату выдачи/срок действия и протокол — по всем
// сотрудникам сразу, с фильтром по объекту/отделу (единый фильтр, как на других вкладках)
// и текстовым поиском по номеру сертификата или ФИО.
router.get('/certificates', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { object, department, q } = req.query;
    let sql = `
      SELECT a.id, a.certificate_number, a.test_date, a.next_test_date, a.protocol_number, a.status,
             u.id AS user_id, u.last_name, u.first_name, u.object, u.department, u.position,
             c.title_ru, c.title_kz, c.no_expiry
      FROM assignments a
      JOIN users u ON u.id = a.user_id
      JOIN courses c ON c.id = a.course_id
      WHERE a.certificate_number IS NOT NULL AND u.role = 'employee'
    `;
    const params = [];
    const objects = splitMulti(object);
    const departments = splitMulti(department);
    if (objects.length) { params.push(objects); sql += ` AND u.object = ANY($${params.length}::text[])`; }
    if (departments.length) { params.push(departments); sql += ` AND u.department = ANY($${params.length}::text[])`; }
    if (q) {
      params.push(`%${q}%`);
      sql += ` AND (a.certificate_number ILIKE $${params.length} OR u.last_name ILIKE $${params.length}
                     OR u.first_name ILIKE $${params.length} OR u.full_name_translit ILIKE $${params.length})`;
    }
    sql += ' ORDER BY a.certificate_number DESC NULLS LAST, a.test_date DESC';
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Start test
router.post('/:id/start', authRequired, async (req, res) => {
  try {
    const aRes = await query('SELECT * FROM assignments WHERE id = $1', [req.params.id]);
    const a = aRes.rows[0];
    if (!a) return res.status(404).json({ error: 'not_found' });
    if (req.user.role === 'employee' && a.user_id !== req.user.id) {
      return res.status(403).json({ error: 'forbidden' });
    }
    if (a.status === 'passed') return res.status(400).json({ error: 'already_passed' });
    if (a.attempts_used > 0 && !a.retake_allowed) {
      return res.status(400).json({ error: 'retake_not_allowed' });
    }

    // Курс может хранить тесты в виде нескольких вариантов (билетов) — 10 билетов по 10 вопросов.
    // При каждой попытке случайным образом выбирается один заполненный билет.
    const variantsRes = await query(
      'SELECT DISTINCT variant_number FROM questions WHERE course_id = $1 ORDER BY variant_number',
      [a.course_id]
    );
    const variants = variantsRes.rows.map(r => r.variant_number);
    const chosenVariant = variants.length ? variants[Math.floor(Math.random() * variants.length)] : null;

    await query(
      `UPDATE assignments SET status='in_progress', attempts_used = attempts_used + 1, retake_allowed = 0, assigned_variant = $2 WHERE id = $1`,
      [req.params.id, chosenVariant]
    );

    const questionsRes = chosenVariant
      ? await query(
          'SELECT id, course_id, question_ru, question_kz, options_ru, options_kz FROM questions WHERE course_id = $1 AND variant_number = $2 ORDER BY sort_order, id LIMIT 10',
          [a.course_id, chosenVariant]
        )
      : await query(
          'SELECT id, course_id, question_ru, question_kz, options_ru, options_kz FROM questions WHERE course_id = $1 ORDER BY RANDOM() LIMIT 10',
          [a.course_id]
        );
    res.json({ ok: true, questions: questionsRes.rows, variant: chosenVariant });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Submit test
router.post('/:id/submit', authRequired, async (req, res) => {
  try {
    const aRes = await query('SELECT * FROM assignments WHERE id = $1', [req.params.id]);
    const a = aRes.rows[0];
    if (!a) return res.status(404).json({ error: 'not_found' });

    const cRes = await query('SELECT * FROM courses WHERE id = $1', [a.course_id]);
    const course = cRes.rows[0];
    // Считаем результат только по вопросам того билета (варианта), который был выдан при старте попытки.
    // Для старых попыток без привязки к варианту (assigned_variant пуст) используем все вопросы курса, как раньше.
    const qRes = a.assigned_variant
  ? await query('SELECT * FROM questions WHERE course_id = $1 AND variant_number = $2', [a.course_id, a.assigned_variant])
  : await query('SELECT * FROM questions WHERE course_id = $1', [a.course_id]);
    const questions = qRes.rows;

    const { answers, focus_violations } = req.body;
    let correctCount = 0;
    for (const q of questions) {
      if (answers && answers[q.id] === q.correct_index) correctCount++;
    }

    const total = questions.length || 1;
    const scorePercent = Math.round((correctCount / total) * 100);
    const passed = scorePercent >= course.pass_score_percent;

    let certNum = a.certificate_number;
    if (passed && !certNum) {
      certNum = await getCertNumberForUser(a.user_id);
    }

    const now = new Date();
    const testDate = now.toISOString();
    // Бессрочный курс: сертификат не истекает, даты следующего прохождения нет (NULL)
    const nextDate = course.no_expiry ? null : new Date(now.setMonth(now.getMonth() + (course.validity_months || 12))).toISOString();

    // Автоматическое присвоение номера протокола (п.1 запроса): если сегодня
    // действует открытый администратором протокол (дата попадает в диапазон
    // open_date..close_date), то именно его номер и дата открытия проставляются
    // сотруднику, который в этот период сдал тест — независимо от того, что было
    // введено вручную при назначении теста.
    let protocolNumber = a.protocol_number;
    let protocolDate = a.protocol_date;
    let protocolId = a.protocol_id;
    // Протокол присваивается и тем, кто НЕ сдал: в Word-протоколе комиссии они попадают в таблицу
    // с отметкой «подлежит повторной проверке знаний».
    {
      const todayStr = testDate.slice(0, 10);
      const activeProtocol = await findActiveProtocol(todayStr);
      if (activeProtocol) {
        protocolNumber = activeProtocol.protocol_number;
        protocolDate = activeProtocol.open_date instanceof Date
          ? activeProtocol.open_date.toISOString().slice(0, 10)
          : String(activeProtocol.open_date);
        protocolId = activeProtocol.id;
      }
    }

    // Сохраняем ответы сотрудника (что выбрал на каждый вопрос) — нужно для
    // истории тестирования в карточке профиля (п.2 запроса): видно, на что
    // ответил правильно, а на что нет, даже после смены его номера сертификата.
    const answersJson = answers ? JSON.stringify(answers) : null;

    await query(`
      UPDATE assignments
      SET status = $1, score_percent = $2, focus_violations = $3,
          certificate_number = $4, test_date = $5, next_test_date = $6,
          protocol_number = $7, protocol_date = $8, protocol_id = $9, user_answers = $10
      WHERE id = $11
    `, [passed ? 'passed' : 'failed', scorePercent, focus_violations || 0, certNum, testDate, nextDate,
        protocolNumber, protocolDate, protocolId, answersJson, a.id]);

    res.json({ passed, scorePercent, certificate_number: certNum, protocol_number: protocolNumber });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Детализация попытки — какие вопросы были заданы, что ответил сотрудник и
// какой ответ был правильным (п.2 запроса: история тестирования в профиле).
router.get('/:id/answers', authRequired, async (req, res) => {
  try {
    const aRes = await query('SELECT * FROM assignments WHERE id = $1', [req.params.id]);
    const a = aRes.rows[0];
    if (!a) return res.status(404).json({ error: 'not_found' });
    if (req.user.role === 'employee' && a.user_id !== req.user.id) {
      return res.status(403).json({ error: 'forbidden' });
    }
    if (!a.user_answers) return res.json({ questions: [] });

    const qRes = a.assigned_variant
      ? await query('SELECT * FROM questions WHERE course_id = $1 AND variant_number = $2 ORDER BY sort_order, id', [a.course_id, a.assigned_variant])
      : await query('SELECT * FROM questions WHERE course_id = $1 ORDER BY sort_order, id', [a.course_id]);

    const userAnswers = a.user_answers; // JSONB -> объект {question_id: chosen_index}
    const questions = qRes.rows.map(q => {
      const chosen = userAnswers[q.id] !== undefined ? userAnswers[q.id] : (userAnswers[String(q.id)] !== undefined ? userAnswers[String(q.id)] : null);
      return {
        id: q.id,
        question_ru: q.question_ru,
        question_kz: q.question_kz,
        options_ru: q.options_ru,
        options_kz: q.options_kz,
        correct_index: q.correct_index,
        chosen_index: chosen === null ? null : Number(chosen),
        is_correct: chosen !== null && Number(chosen) === q.correct_index
      };
    });
    res.json({ questions });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Allow retake
router.post('/:id/allow-retake', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    await query(`UPDATE assignments SET retake_allowed = 1, status = 'pending' WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Delete assignment (удаление записи назначения/истории прохождения — только суперадмин;
// обычным админам это действие недоступно намеренно, п. запроса)
router.delete('/:id', authRequired, requireRole('superadmin'), async (req, res) => {
  try {
    await query('DELETE FROM assignments WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Общие хелперы для исторических (уже пройденных ранее) записей обучения —
// используются также при массовом импорте сотрудников из Excel (routes/users.js),
// когда в том же файле сразу указаны протокол/сертификат/дата прохождения.
module.exports = router;
router.buildHistoricalFields = buildHistoricalFields;
