const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const { initDb } = require('./db');

const app = express();
// За прокси Render реальный IP клиента приходит в X-Forwarded-For; без этого req.ip — адрес прокси
// и лимитер публичных роутов (lib/rateLimit.js) считал бы всех посетителей одним.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

app.use(cors());
// Увеличенный лимит нужен, т.к. логотип/печать/подписи теперь передаются
// как base64 прямо в JSON-теле запроса (см. routes/settings.js).
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Логотип/печать/подписи/материалы/видео курсов теперь загружаются в Supabase
// Storage (см. supabaseStorage.js, routes/settings.js, routes/courses.js) и не
// хранятся на локальном диске сервера — он не persistent на большинстве хостингов.
// Папка 'imports' оставлена для временного чтения Excel-файла импорта сотрудников
// (routes/users.js), он не хранится долгосрочно.
fs.mkdirSync(path.join(__dirname, 'uploads', 'imports'), { recursive: true });

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
// ВАЖНО: корень проекта больше НЕ раздаётся как статика. Раньше `express.static(__dirname)` отдавал
// по прямой ссылке любой файл из корня (db.js, Server.js, package.json, любые случайные файлы
// вроде «download» с логином/паролем суперадмина и т.п.). Фронтенд ничего из корня не подгружает:
// index.html / verify.html / person.html отдаются ниже явными роутами, остальное берётся с CDN.

// Подключение роутов
const { router: authRouter } = require('./routes/auth');
app.use('/api/auth', authRouter);
app.use('/api/users', require('./routes/users'));
app.use('/api/courses', require('./routes/courses'));
app.use('/api/assignments', require('./routes/assignments'));
// Массовое обновление через Excel: выгрузка сотрудников -> новое обучение -> загрузка обратно
app.use('/api/bulk-training', require('./routes/bulkTraining'));
app.use('/api/protocols', require('./routes/protocols'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/export', require('./routes/export'));
app.use('/api/certificates', require('./routes/certificate'));
// Удостоверения — отдельный документ, не сертификат (см. idCardService.js)
app.use('/api/id-cards', require('./routes/idCards'));
// Публичные данные сотрудника по общему QR (без авторизации, с лимитом запросов)
app.use('/api/public', require('./routes/public'));
app.use('/api/signatures', require('./routes/signatures'));
// Журнал действий администраторов/ассистентов (только суперадмин)
app.use('/api/audit', require('./routes/audit'));
// Запасное хранилище в Google Drive: статус, «Выгрузить всё» (только суперадмин)
app.use('/api/drive', require('./routes/drive'));

// Публичная страница проверки подлинности удостоверения (QR-код на удостоверении
// ведёт сюда) — отдельная лёгкая статическая страница, без авторизации и без
// загрузки всего SPA (index.html). Данные подтягивает сама через
// GET /api/certificates/verify/:uid (см. routes/certificate.js).
app.get('/verify/:uid', (req, res) => {
  res.sendFile(path.join(__dirname, 'verify.html'));
});

// Публичная страница сотрудника — сюда ведёт ОБЩИЙ QR на всех его удостоверениях
// (public_uid вида P-XXXXXXXXXX, см. lib/publicUid.js). Как и /verify/:uid — лёгкая статическая
// страница без авторизации и без загрузки всего SPA; данные она берёт сама через
// GET /api/public/person/:uid (routes/public.js: лимит запросов с IP, только публичные поля).
// Пока этот файл лежит в корне проекта, routes/idCards.js кладёт в QR именно /p/<public_uid>.
app.get('/p/:uid', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(path.join(__dirname, 'person.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Запуск после подключения и проверки таблиц в Supabase
initDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`✅ TB Training Platform запущен на порту ${PORT} (база данных Supabase)`);
      // Фоновая отправка файлов в Google Drive (если заданы GDRIVE_*); сайт от неё не зависит
      try { require('./driveSync').startWorker(); } catch (e) { console.error('[drive] не удалось запустить воркер:', e.message); }
    });
  })
  .catch(err => {
    console.error('Ошибка подключения к базе данных Supabase:', err);
    process.exit(1);
  });
