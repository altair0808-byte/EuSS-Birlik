const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const { initDb } = require('./db');

const app = express();
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
app.use(express.static(path.join(__dirname)));

// Подключение роутов
const { router: authRouter } = require('./routes/auth');
app.use('/api/auth', authRouter);
app.use('/api/users', require('./routes/users'));
app.use('/api/courses', require('./routes/courses'));
app.use('/api/assignments', require('./routes/assignments'));
app.use('/api/protocols', require('./routes/protocols'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/export', require('./routes/export'));
app.use('/api/certificates', require('./routes/certificate'));
app.use('/api/signatures', require('./routes/signatures'));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Запуск после подключения и проверки таблиц в Supabase
initDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`✅ TB Training Platform запущен на порту ${PORT} (база данных Supabase)`);
    });
  })
  .catch(err => {
    console.error('Ошибка подключения к базе данных Supabase:', err);
    process.exit(1);
  });
