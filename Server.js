require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

require('./db'); // init DB + seed superadmin

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

// Подключаем роуты прямо из текущей папки
app.use('/api/auth', require('./auth'));
app.use('/api/users', require('./users'));
app.use('/api/courses', require('./courses'));
app.use('/api/assignments', require('./assignments'));
app.use('/api/settings', require('./settings'));
app.use('/api/certificates', require('./certificate')); // имя файла certificate.js (без s)
app.use('/api/export', require('./export'));

app.get('/', (req, res) => {
  // Проверяем index.html в public или в корне
  const fs = require('fs');
  const publicIndex = path.join(__dirname, 'public', 'index.html');
  const rootIndex = path.join(__dirname, 'index.html');
  if (fs.existsSync(publicIndex)) {
    res.sendFile(publicIndex);
  } else {
    res.sendFile(rootIndex);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ TB Training Platform запущен на порту ${PORT}`);
});
