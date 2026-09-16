const express = require('express');
const ExcelJS = require('exceljs');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('ru-RU');
}

// GET /api/export/excel?object=Бирлик&status=passed
router.get('/excel', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  const { object, status } = req.query;
  if (!object) return res.status(400).json({ error: 'object_required' });

  let sql = `
    SELECT a.certificate_number, u.last_name, u.first_name, u.department, u.position,
           a.protocol_number, a.protocol_date, a.test_date, a.next_test_date, a.status
    FROM assignments a
    JOIN users u ON u.id = a.user_id
    WHERE u.object = ?`;
  const params = [object];
  if (status) { sql += ' AND a.status = ?'; params.push(status); }
  sql += ' ORDER BY u.department, u.last_name, u.first_name';
  const rows = db.prepare(sql).all(...params);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'TB Training Platform';
  wb.created = new Date();

  const byDept = {};
  for (const r of rows) {
    const dept = r.department || 'Без отдела';
    if (!byDept[dept]) byDept[dept] = [];
    byDept[dept].push(r);
  }

  const headers = ['№ п/п', 'Номер сертификата', 'Фамилия', 'Имя', 'Отдел', 'Должность',
                    '№ Протокола', 'Дата протокола', 'Дата прохождения', 'Дата след. прохождения', 'Статус'];

  const statusLabel = { passed: 'Пройден', failed: 'Не пройден', pending: 'Ожидает', in_progress: 'В процессе' };

  const deptNames = Object.keys(byDept).length ? Object.keys(byDept) : ['Нет данных'];
  for (const dept of deptNames) {
    // Excel sheet names: max 31 chars, no special chars \/*?[]:
    const safeName = dept.replace(/[\\/*?\[\]:]/g, '-').slice(0, 31) || 'Отдел';
    const ws = wb.addWorksheet(safeName);
    ws.columns = headers.map((h, i) => ({ header: h, key: `c${i}`, width: i === 2 || i === 3 ? 18 : i === 1 ? 16 : 16 }));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } };

    const list = byDept[dept] || [];
    list.forEach((r, idx) => {
      ws.addRow([
        idx + 1,
        r.certificate_number || '',
        r.last_name,
        r.first_name,
        r.department,
        r.position,
        r.protocol_number,
        fmtDate(r.protocol_date),
        fmtDate(r.test_date),
        fmtDate(r.next_test_date),
        statusLabel[r.status] || r.status
      ]);
    });
    ws.autoFilter = { from: 'A1', to: `K1` };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }

  const safeObjectName = object.replace(/[^\p{L}\p{N}_-]/gu, '_');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="export_${safeObjectName}.xlsx"`);

  await wb.xlsx.write(res);
  res.end();
});

module.exports = router;
