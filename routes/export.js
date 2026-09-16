const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { query } = require('../db');
const { authRequired, requireRole } = require('./auth');

router.get('/excel', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { object, department, course_id, status } = req.query;
    let sql = `
      SELECT a.*, u.last_name, u.first_name, u.object, u.department, u.position, u.login,
             c.title_ru, c.pass_score_percent
      FROM assignments a
      JOIN users u ON u.id = a.user_id
      JOIN courses c ON c.id = a.course_id
      WHERE 1=1
    `;
    const params = [];
    if (object) { params.push(object); sql += ` AND u.object = $${params.length}`; }
    if (department) { params.push(department); sql += ` AND u.department = $${params.length}`; }
    if (course_id) { params.push(course_id); sql += ` AND a.course_id = $${params.length}`; }
    if (status) { params.push(status); sql += ` AND a.status = $${params.length}`; }
    sql += ' ORDER BY a.created_at DESC';

    const result = await query(sql, params);
    const rows = result.rows;

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Журнал обучения');
    ws.columns = [
      { header: 'ID', key: 'id', width: 8 },
      { header: 'Фамилия', key: 'last_name', width: 18 },
      { header: 'Имя', key: 'first_name', width: 18 },
      { header: 'Табельный номер', key: 'login', width: 16 },
      { header: 'Объект', key: 'object', width: 20 },
      { header: 'Отдел', key: 'department', width: 20 },
      { header: 'Должность', key: 'position', width: 22 },
      { header: 'Курс', key: 'title_ru', width: 30 },
      { header: 'Статус', key: 'status', width: 14 },
      { header: 'Результат %', key: 'score_percent', width: 14 },
      { header: 'Номер сертификата', key: 'certificate_number', width: 20 },
      { header: 'Номер протокола', key: 'protocol_number', width: 18 }
    ];

    rows.forEach(r => ws.addRow(r));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="journal_export.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    res.status(500).json({ error: 'export_failed', details: e.message });
  }
});

module.exports = router;
