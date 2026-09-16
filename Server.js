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

app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/courses', require('./routes/courses'));
app.use('/api/assignments', require('./routes/assignments'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/certificates', require('./routes/certificates'));
app.use('/api/export', require('./routes/export'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ TB Training Platform запущен: http://localhost:${PORT}`);
});
