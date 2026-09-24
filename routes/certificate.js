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
      resolveImageBuffer(s.stamp_data || s.stamp_path),
      resolveImageBuffer(s.chairman1_signature),
      resolveImageBuffer(s.chairman2_signature)
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
    doc.text(`«${courseTitle}»`, 60, 277, { align: 'center', width: PAGE_W - 120 });

    fRegular(9.5);
    doc.fillColor('#333333');
    const issueDateStr = fmtDate(a.test_date || a.protocol_date);
    const validUntilStr = fmtDate(a.next_test_date);
    const protStr = a.protocol_number ? `Протокол № ${a.protocol_number}` : '';
    doc.text(`Дата выдачи: ${issueDateStr}     Действителен до: ${validUntilStr}     ${protStr}`, 0, 320, { align: 'center' });

    // ===================== Блок подписей: ровно два председателя комиссии =====================
    // Никаких "членов комиссии" — только два столбца, широко разнесённые, чтобы
    // печать могла аккуратно лечь на подпись одного из них, не задевая имя,
    // должность или подпись второго председателя.
    const committee = [
      {
        role: s.chairman1_position || 'Председатель комиссии',
        name: s.chairman1_name || s.chairman_name || '—',
        sig: sig1Buf
      },
      {
        role: s.chairman2_position || 'Председатель комиссии',
        name: s.chairman2_name || '—',
        sig: sig2Buf
      }
    ].filter(m => m.name && m.name !== '—');
    // Если второй председатель ещё не заполнен в настройках, показываем только первого,
    // чтобы не рисовать пустой столбец.
    const finalCommittee = committee.length ? committee : [
      { role: s.chairman1_position || 'Председатель комиссии', name: s.chairman1_name || s.chairman_name || 'Председатель комиссии', sig: sig1Buf }
    ];

    // Две колонки шириной 260 с зазором 90 между ними (если председатель один —
    // одна широкая колонка по центру). Зазор нужен, чтобы печать могла аккуратно
    // лечь на край подписи первого председателя, не задевая вторую колонку.
    const twoUp = finalCommittee.length === 2;
    const colW = twoUp ? 260 : 320;
    const gap = 90;
    const totalW = twoUp ? colW * 2 + gap : colW;
    const startX = (PAGE_W - totalW) / 2;

    const roleY = 400;      // должность
    const sigTopY = 420;    // верх зоны для картинки подписи
    const sigH = 55;        // высота зоны подписи — крупная и разборчивая
    const lineY = 490;      // линия под подписью
    const nameY = 505;      // ФИО под линией

    finalCommittee.forEach((m, i) => {
      const colX = startX + i * (colW + gap);
      const centerX = colX + colW / 2;

      fBold(9.5);
      doc.fillColor('#000000');
      doc.text(m.role, colX, roleY, { width: colW, align: 'center' });

      if (m.sig) {
        try {
          const sigW = 150;
          doc.image(m.sig, centerX - sigW / 2, sigTopY, { width: sigW, height: sigH, fit: [sigW, sigH], align: 'center', valign: 'bottom' });
        } catch (e) {
          console.error('Ошибка вставки подписи:', e);
        }
      }

      doc.moveTo(colX + colW * 0.12, lineY).lineTo(colX + colW * 0.88, lineY).strokeColor('#888888').lineWidth(0.8).stroke();

      fRegular(9.5);
      doc.fillColor('#000000');
      doc.text(m.name, colX, nameY, { width: colW, align: 'center' });
    });

    // Печать — накладывается на подпись ПЕРВОГО председателя (обычная практика
    // заверения подписи печатью), крупная и хорошо читаемая. Её вертикальный
    // диапазон подобран так, чтобы она перекрывала саму картинку подписи, но не
    // заезжала на строку с ФИО под линией и не касалась второй колонки.
    if (stampBuf && finalCommittee.length) {
      try {
        const firstColCenterX = startX + colW / 2;
        const stampSize = 95;
        const stampCenterY = (sigTopY + lineY) / 2; // центр между подписью и линией
        doc.save();
        doc.opacity(0.85);
        doc.image(stampBuf, firstColCenterX - stampSize / 2, stampCenterY - stampSize / 2, {
          width: stampSize,
          height: stampSize,
          fit: [stampSize, stampSize]
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
