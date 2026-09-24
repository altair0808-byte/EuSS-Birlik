const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { query } = require('../db');
const { authRequired } = require('./auth');

const FONT_REG = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans.ttf');
const FONT_BOLD = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans-Bold.ttf');

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('ru-RU');
}

// Скачивает файл по http(s) ссылке (логотип/печать/подпись теперь хранятся в
// Supabase Storage и приходят в виде публичного URL, а не локального пути).
function fetchRemoteBuffer(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (resp) => {
      if (resp.statusCode && resp.statusCode >= 400) {
        resp.resume();
        return reject(new Error('HTTP ' + resp.statusCode + ' for ' + url));
      }
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => resolve(Buffer.concat(chunks)));
      resp.on('error', reject);
    }).on('error', reject);
  });
}

async function resolveImageBuffer(imgVal) {
  if (!imgVal) return null;
  try {
    if (imgVal.startsWith('data:image')) {
      const idx = imgVal.indexOf('base64,');
      if (idx !== -1) {
        return Buffer.from(imgVal.slice(idx + 7), 'base64');
      }
    }
    if (/^https?:\/\//i.test(imgVal)) {
      return await fetchRemoteBuffer(imgVal);
    }
    const localPath = path.join(__dirname, '..', imgVal.replace(/^\//, ''));
    if (fs.existsSync(localPath)) {
      return fs.readFileSync(localPath);
    }
  } catch (e) {
    console.error('Error resolving image buffer:', e);
  }
  return null;
}

// ===================== Реальные размеры печати и подписи =====================
// Страница PDF = A4 альбомная = 842 x 595 pt = 297 x 210 мм, то есть 1 мм = 72/25.4 pt.
// Если печатать сертификат в масштабе 100% («Реальный размер», а не «По размеру страницы»),
// размеры ниже получаются на бумаге ровно в миллиметрах.
const MM = 72 / 25.4;
const STAMP_D = 42 * MM;      // круглая печать организации: обычно 40–45 мм, берём 42 мм (≈119 pt)
const SIG_MAX_W = 55 * MM;    // рукописная подпись: до 55 мм в ширину (≈156 pt)
const SIG_MAX_H = 22 * MM;    // ...и до 22 мм в высоту (≈62 pt)

// sharp нужен только для «подчистки» загруженных изображений печати/подписи. Если пакет
// вдруг не установлен — сертификат всё равно формируется, просто без автообрезки полей.
let sharp = null;
try { sharp = require('sharp'); } catch (e) {
  console.warn('[certificate] пакет sharp не найден — печать и подпись вставляются как есть (без автообрезки полей)');
}

const cleanedImageCache = new Map();

// Загруженные сканы/фото печати и подписи почти всегда имеют широкие белые поля вокруг рисунка —
// из-за этого на сертификате сам оттиск выглядит в 1,5–2 раза мельче, чем размер файла.
// Здесь: (1) белый фон бумаги делаем прозрачным (чтобы печать не «закрашивала» подпись под собой),
// (2) обрезаем пустые поля по границам оттиска. Любая ошибка -> возвращаем исходный файл.
async function trimStampLikeImage(buf, cacheKey) {
  if (!sharp || !buf) return buf;
  if (cacheKey && cleanedImageCache.has(cacheKey)) return cleanedImageCache.get(cacheKey);
  try {
    const { data, info } = await sharp(buf, { limitInputPixels: 50e6 })
      .rotate()                                                   // учесть EXIF-поворот фото
      .resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height } = info;

    const isPaper = (i) => data[i + 3] > 200 && Math.min(data[i], data[i + 1], data[i + 2]) >= 225;
    const at = (x, y) => (y * width + x) * 4;
    const paperCorners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)]
      .filter(isPaper).length;
    if (paperCorners >= 3) {
      // Непрозрачный светлый фон (скан/фото) -> плавно превращаем «белое» в прозрачное.
      for (let i = 0; i < data.length; i += 4) {
        const m = Math.min(data[i], data[i + 1], data[i + 2]);
        if (m >= 235) data[i + 3] = 0;
        else if (m > 190) data[i + 3] = Math.round(data[i + 3] * (235 - m) / 45);
      }
    }

    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] > 40) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return buf; // изображение целиком прозрачное/белое — не трогаем

    const pad = 2;
    const left = Math.max(0, minX - pad);
    const top = Math.max(0, minY - pad);
    const cw = Math.min(width, maxX + pad + 1) - left;
    const ch = Math.min(height, maxY + pad + 1) - top;

    const out = await sharp(data, { raw: { width, height, channels: 4 } })
      .extract({ left, top, width: cw, height: ch })
      .png()
      .toBuffer();
    if (cacheKey) {
      if (cleanedImageCache.size > 12) cleanedImageCache.clear();
      cleanedImageCache.set(cacheKey, out);
    }
    return out;
  } catch (e) {
    console.error('Не удалось подготовить изображение печати/подписи, используется исходное:', e.message);
    return buf;
  }
}

// Печать/подпись: загрузить + убрать белые поля (логотип это не касается)
async function resolveCleanImage(imgVal) {
  const buf = await resolveImageBuffer(imgVal);
  if (!buf) return null;
  const key = /^https?:\/\//i.test(imgVal || '') ? imgVal : null;
  return trimStampLikeImage(buf, key);
}

router.get('/:id', authRequired, async (req, res) => {
  const assignmentId = req.params.id;
  try {
    const aRes = await query(
      `SELECT a.*,
              u.last_name, u.first_name, u.position as user_position, u.department, u.object,
              c.title_ru, c.title_kz, c.validity_months
       FROM assignments a
       JOIN users u ON a.user_id = u.id
       JOIN courses c ON a.course_id = c.id
       WHERE a.id = $1`,
      [assignmentId]
    );
    if (aRes.rows.length === 0) {
      return res.status(404).json({ error: 'not_found' });
    }
    const a = aRes.rows[0];

    if (req.user.role === 'employee' && Number(req.user.id) !== Number(a.user_id)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    if (a.status !== 'passed') {
      return res.status(400).json({ error: 'not_passed' });
    }

    const sRes = await query('SELECT * FROM settings WHERE id = 1');
    const s = sRes.rows[0] || {};

    // Предзагружаем все изображения ДО начала рисования PDF (они теперь могут
    // быть удалёнными ссылками на Supabase Storage, а не локальными файлами).
    const [logoBuf, stampBuf, sig1Buf, sig2Buf] = await Promise.all([
      resolveImageBuffer(s.logo_data || s.logo_path),
      resolveCleanImage(s.stamp_data || s.stamp_path),
      resolveCleanImage(s.chairman1_signature),
      resolveCleanImage(s.chairman2_signature)
    ]);

    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margins: { top: 30, bottom: 30, left: 35, right: 35 }
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="certificate_${encodeURIComponent(a.certificate_number || a.id)}.pdf"`
    );
    doc.pipe(res);

    if (fs.existsSync(FONT_REG)) doc.registerFont('DejaVu', FONT_REG);
    if (fs.existsSync(FONT_BOLD)) doc.registerFont('DejaVu-Bold', FONT_BOLD);
    const hasFonts = fs.existsSync(FONT_REG);

    const fRegular = (size = 11) => {
      if (hasFonts) doc.font('DejaVu').fontSize(size);
      else doc.fontSize(size);
    };
    const fBold = (size = 11) => {
      if (hasFonts && fs.existsSync(FONT_BOLD)) doc.font('DejaVu-Bold').fontSize(size);
      else doc.fontSize(size);
    };

    const PAGE_W = 842, PAGE_H = 595;

    // Рамка документа
    doc.rect(20, 20, PAGE_W - 40, PAGE_H - 40).lineWidth(2).strokeColor('#0f3b6c').stroke();
    doc.rect(26, 26, PAGE_W - 52, PAGE_H - 52).lineWidth(0.8).strokeColor('#8aa8c8').stroke();

    // Логотип
    if (logoBuf) {
      try {
        doc.image(logoBuf, 50, 38, { width: 88, height: 52, fit: [88, 52] });
      } catch (e) {
        console.error('Ошибка вставки логотипа в PDF:', e);
      }
    }

    fBold(15);
    doc.fillColor('#0f3b6c');
    doc.text(s.company_name || 'ТОО «Компания»', 150, 46, { align: 'center', width: 542 });

    fBold(25);
    doc.fillColor('#1b365d');
    doc.text('СЕРТИФИКАТ', 0, 108, { align: 'center' });

    fBold(12);
    doc.fillColor('#333333');
    doc.text(`№ ${a.certificate_number || '—'}`, 0, 142, { align: 'center' });

    fRegular(11);
    doc.fillColor('#444444');
    doc.text('Настоящим подтверждается, что / Осы арқылы расталады:', 0, 170, { align: 'center' });

    fBold(19);
    doc.fillColor('#000000');
    doc.text(`${a.last_name || ''} ${a.first_name || ''}`.trim(), 0, 195, { align: 'center' });

    fRegular(10.5);
    doc.fillColor('#555555');
    const empDetails = [a.position || a.user_position, a.department, a.object].filter(Boolean).join(' • ');
    if (empDetails) {
      doc.text(empDetails, 0, 223, { align: 'center' });
    }

    fRegular(11);
    doc.fillColor('#444444');
    doc.text('успешно прошел(ла) проверку знаний по курсу / келесі курс бойынша білімін сәтті тексеруден өтті:', 0, 253, { align: 'center' });

    fBold(13.5);
    doc.fillColor('#0f3b6c');
    const courseTitle = a.title_ru || a.title_kz || 'Курс';
    doc.text(`«${courseTitle}»`, 60, 277, { align: 'center', width: PAGE_W - 120, height: 36, ellipsis: true });

    fRegular(9.5);
    doc.fillColor('#333333');
    const issueDateStr = fmtDate(a.test_date || a.protocol_date);
    const validUntilStr = fmtDate(a.next_test_date);
    const protStr = a.protocol_number ? `Протокол № ${a.protocol_number}` : '';
    doc.text(`Дата выдачи: ${issueDateStr}     Действителен до: ${validUntilStr}     ${protStr}`, 0, 322, { align: 'center' });

    // ===================== Блок подписи: используется ТОЛЬКО выбранный председатель =====================
    // На сертификате всегда показывается один председатель — тот, кто отмечен
    // галочкой "Использовать на сертификате" в настройках (active_chairman).
    // Данные второго председателя (ФИО, должность, подпись) на сертификат не
    // попадают вовсе, пока не выбран именно он.
    const isChair2Active = parseInt(s.active_chairman, 10) === 2;
    const activeChair = isChair2Active
      ? { role: s.chairman2_position || 'Председатель комиссии', name: s.chairman2_name || '—', sig: sig2Buf }
      : { role: s.chairman1_position || 'Председатель комиссии', name: s.chairman1_name || s.chairman_name || '—', sig: sig1Buf };
    const finalCommittee = [activeChair];

    // Одна колонка по центру листа. Печать и подпись рисуются в реальных размерах
    // (см. константы STAMP_D / SIG_MAX_W / SIG_MAX_H выше): печать ≈ 42 мм, подпись до 55 x 22 мм.
    const colW = 320;
    const colX = (PAGE_W - colW) / 2;
    const centerX = colX + colW / 2;

    const roleY = 380;                          // должность
    const sigBoxTop = 402;                      // верх зоны подписи
    const sigBoxBottom = sigBoxTop + SIG_MAX_H; // низ зоны подписи (≈464)
    const lineY = sigBoxBottom + 4;             // линия под подписью
    const nameY = lineY + 6;                    // ФИО под линией

    const m = finalCommittee[0];

    fBold(9.5);
    doc.fillColor('#000000');
    const roleHalfW = Math.min(doc.widthOfString(m.role) / 2, colW / 2);
    const roleH = Math.min(doc.heightOfString(m.role, { width: colW }), 24);
    doc.text(m.role, colX, roleY, { width: colW, align: 'center', height: 24, ellipsis: true });

    // Подпись — по центру зоны, «сидит» на линии
    if (m.sig) {
      try {
        doc.image(m.sig, centerX - SIG_MAX_W / 2, sigBoxTop, {
          fit: [SIG_MAX_W, SIG_MAX_H], align: 'center', valign: 'bottom'
        });
      } catch (e) {
        console.error('Ошибка вставки подписи:', e);
      }
    }

    doc.moveTo(centerX - 95, lineY).lineTo(centerX + 95, lineY).strokeColor('#888888').lineWidth(0.8).stroke();

    fRegular(9.5);
    doc.fillColor('#000000');
    const nameHalfW = Math.min(doc.widthOfString(m.name) / 2, colW / 2);
    doc.text(m.name, colX, nameY, { width: colW, align: 'center', lineBreak: false });

    // Печать — как на бумажных документах: накладывается на правую часть подписи и смещена в
    // сторону, так что подпись читается, а сама печать не заходит ни на должность, ни на ФИО.
    // Смещение считается от реальной ширины этих строк (край круга проверяется на высоте строк).
    if (stampBuf) {
      try {
        const r = STAMP_D / 2;
        const stampCenterY = (sigBoxTop + lineY) / 2 + 2;   // ≈ середина подписи
        const chordHalf = (lineOrY, lineHeight) => {
          // Половина ширины круга на высоте ближайшего к центру края строки текста
          const nearest = lineOrY < stampCenterY
            ? Math.min(stampCenterY, lineOrY + lineHeight)
            : Math.max(stampCenterY, lineOrY);
          const dy = Math.abs(nearest - stampCenterY);
          return dy >= r ? 0 : Math.sqrt(r * r - dy * dy);
        };
        const gap = 6;
        const offset = Math.max(
          roleHalfW + gap + chordHalf(roleY, roleH),
          nameHalfW + gap + chordHalf(nameY, 11),
          r * 0.6
        );
        const stampCenterX = centerX + offset;
        doc.save();
        doc.opacity(0.9);
        doc.image(stampBuf, stampCenterX - r, stampCenterY - r, {
          fit: [STAMP_D, STAMP_D], align: 'center', valign: 'center'
        });
        doc.restore();
      } catch (e) {
        console.error('Ошибка вставки печати:', e);
      }
    }

    doc.end();
  } catch (e) {
    console.error('Certificate generation error:', e);
    if (!res.headersSent) {
      res.status(500).json({ error: 'cert_error', details: e.message });
    }
  }
});

module.exports = router;
