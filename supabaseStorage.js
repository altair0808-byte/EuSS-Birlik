// Загрузка файлов (логотип, печать, подписи, материалы курсов, видео) в Supabase
// Storage вместо локального диска сервера и вместо base64 в колонках базы.
//
// Зачем: на большинстве хостингов (Render/Railway/Heroku-подобные) локальный диск
// сбрасывается при каждом redeploy — загруженные файлы терялись. Также хранение
// логотипа/печати/подписи как base64 прямо в таблице settings раздувало базу и
// заставляло всё передавать заново при каждом сохранении настроек. Теперь файл
// загружается в Supabase Storage один раз, а в базе хранится только его
// публичная ссылка (URL) — при повторном сохранении других настроек файл заново
// не загружается.
//
// Требуются переменные окружения:
//   SUPABASE_URL              — например https://xxxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY — Service role key проекта (Project Settings → API)
// (Это ДРУГИЕ значения, чем DATABASE_URL — тот используется для прямого
// подключения к Postgres, а эти два нужны для обращения к Supabase Storage API.)

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const BUCKET = process.env.SUPABASE_BUCKET || 'app-uploads';

let client = null;
let bucketReady = false;

function getClient() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error(
      'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY не заданы в переменных окружения — загрузка файлов недоступна'
    );
  }
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false }
    });
  }
  return client;
}

async function ensureBucket() {
  if (bucketReady) return;
  const supabase = getClient();
  try {
    const { data, error } = await supabase.storage.getBucket(BUCKET);
    if (!data && error) {
      const { error: createErr } = await supabase.storage.createBucket(BUCKET, { public: true });
      if (createErr && !/already exists/i.test(createErr.message || '')) {
        console.error('Не удалось создать bucket Supabase Storage:', createErr.message);
      }
    }
  } catch (e) {
    console.error('Ошибка проверки/создания bucket Supabase Storage:', e.message);
  }
  bucketReady = true;
}

function safeExt(originalName) {
  const m = /\.[a-zA-Z0-9]+$/.exec(originalName || '');
  return m ? m[0].toLowerCase() : '';
}

// Загружает буфер в Supabase Storage и возвращает публичную ссылку.
// folder: логическая подпапка внутри bucket'а (logo/stamp/signature/materials/videos/...)
async function uploadBuffer(folder, originalName, buffer, mimetype) {
  await ensureBucket();
  const supabase = getClient();
  const key = `${folder}/${Date.now()}_${Math.round(Math.random() * 1e9)}${safeExt(originalName)}`;
  const { error } = await supabase.storage.from(BUCKET).upload(key, buffer, {
    contentType: mimetype || 'application/octet-stream',
    upsert: false
  });
  if (error) throw error;
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(key);
  return { url: data.publicUrl, key };
}

// Удаляет файл по ранее сохранённому ключу (необязательно — используется, чтобы
// не копить в Storage файлы, замененные новыми).
async function removeByKey(key) {
  if (!key) return;
  try {
    const supabase = getClient();
    await supabase.storage.from(BUCKET).remove([key]);
  } catch (e) {
    console.error('Не удалось удалить старый файл из Supabase Storage:', e.message);
  }
}

function isConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

module.exports = { uploadBuffer, removeByKey, isConfigured, BUCKET };
