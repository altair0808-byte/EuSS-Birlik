// Выгрузка в Excel: «Личные мед. книжки» и «Ежегодный медосмотр» (те же данные и фильтр, что на сайте).
const ExcelJS = require('exceljs');
const { query } = require('../db');

const STATUS_RU = { valid: 'Действует', soon: 'Скоро истекает', overdue: 'Просрочена', no_date: 'Дата не внесена' };
const CAT_RU = { manager: 'Руководитель', specialist: 'Специалист', employee: 'Работник' };
const FILL = { valid: 'FFD1FAE5', soon: 'FFFEF3C7', overdue: 'FFFEE2E2', no_date: 'FFF1F5F9' };

function ymdToDate(s) { return s ? new Date(s + 'T00:00:00Z') : null; }

async function badgesOf(ids) {
  if (!ids.length) return new Map();
  const r = await query('SELECT id, tco_badge, iin FROM users WHERE id = ANY($1::bigint[])', [ids]);
  return new Map(r.rows.map((x) => [Number(x.id), x]));
}

function styleSheet(ws, widths) {
  ws.columns.forEach((c, i) => { c.width = widths[i] || 14; });
  const h = ws.getRow(1);
  h.font = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' } };
  h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
  h.alignment = { vertical: 'middle', wrapText: true };
  h.height = 30;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
}

function addMedbookSheet(wb, rows, extra) {
  const ws = wb.addWorksheet('Мед. книжки');
  ws.columns = [
    { header: '№' }, { header: 'Фамилия' }, { header: 'Имя' }, { header: '№ пропуска' }, { header: 'Объект' },
    { header: 'Отдел' }, { header: 'Должность' }, { header: 'Категория' }, { header: 'Книжка' },
    { header: 'Период, мес.' }, { header: 'Дата медосмотра' }, { header: 'Действует до' },
    { header: 'Осталось дней' }, { header: 'Статус' }, { header: 'Примечание (ФГ, СМ и т.п.)' }
  ];
  rows.forEach((e, i) => {
    const x = extra.get(e.user_id) || {};
    const r = ws.addRow([i + 1, e.last_name, e.first_name, x.tco_badge || '', e.object || '', e.department || '',
      e.position || '', CAT_RU[e.staff_category] || '', e.required ? 'по должности' : 'вне должности',
      e.period_months || null, ymdToDate(e.start_date), ymdToDate(e.expires), e.days_left, STATUS_RU[e.status] || e.status, e.note || '']);
    r.font = { name: 'Arial', size: 10 };
    r.getCell(11).numFmt = 'dd.mm.yyyy'; r.getCell(12).numFmt = 'dd.mm.yyyy';
    r.getCell(14).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL[e.status] || 'FFFFFFFF' } };
  });
  styleSheet(ws, [5, 18, 14, 12, 12, 22, 30, 13, 14, 9, 13, 13, 10, 16, 40]);
  return ws;
}

function addMedexamSheet(wb, rows, extra) {
  const ws = wb.addWorksheet('Ежегодный медосмотр');
  ws.columns = [
    { header: '№' }, { header: 'Фамилия' }, { header: 'Имя' }, { header: '№ пропуска' }, { header: 'Объект' },
    { header: 'Отдел' }, { header: 'Должность' }, { header: 'Категория' }, { header: 'Дата медосмотра' },
    { header: 'Действует до' }, { header: 'Осталось дней' }, { header: 'Статус' }, { header: 'Примечание' }
  ];
  rows.forEach((e, i) => {
    const x = extra.get(e.user_id) || {};
    const r = ws.addRow([i + 1, e.last_name, e.first_name, x.tco_badge || '', e.object || '', e.department || '',
      e.position || '', CAT_RU[e.staff_category] || '', ymdToDate(e.exam_date), ymdToDate(e.expires), e.days_left,
      STATUS_RU[e.status] || e.status, e.note || '']);
    r.font = { name: 'Arial', size: 10 };
    r.getCell(9).numFmt = 'dd.mm.yyyy'; r.getCell(10).numFmt = 'dd.mm.yyyy';
    r.getCell(12).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL[e.status] || 'FFFFFFFF' } };
  });
  styleSheet(ws, [5, 18, 14, 12, 12, 22, 30, 13, 13, 13, 10, 16, 40]);
  return ws;
}

function fillSummary(ws, parts, filterText) {
  ws.addRow(['Выгрузка с сайта обучения EuSS', new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Atyrau' })]).font = { name: 'Arial', bold: true };
  ws.addRow(['Фильтр', filterText || 'все объекты и отделы (в пределах вашего доступа)']);
  ws.addRow([]);
  const h = ws.addRow(['Раздел', 'Всего', 'Действует', 'Скоро истекает (≤30 дн.)', 'Просрочена', 'Дата не внесена']);
  h.font = { name: 'Arial', bold: true };
  parts.forEach(([name, rows]) => {
    const c = { valid: 0, soon: 0, overdue: 0, no_date: 0 };
    rows.forEach((e) => { c[e.status] = (c[e.status] || 0) + 1; });
    ws.addRow([name, rows.length, c.valid, c.soon, c.overdue, c.no_date]).font = { name: 'Arial' };
  });
  [32, 10, 12, 22, 12, 16].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
}

// parts: { medbook?: rows, medexam?: rows }
async function sendMedWorkbook(res, parts, filterText, fileBase) {
  const all = [...(parts.medbook || []), ...(parts.medexam || [])];
  const extra = await badgesOf([...new Set(all.map((e) => e.user_id))]);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'EuSS';
  const summarySheet = wb.addWorksheet('Сводка');   // первой вкладкой
  const summary = [];
  if (parts.medbook) { addMedbookSheet(wb, parts.medbook, extra); summary.push(['Личные мед. книжки', parts.medbook]); }
  if (parts.medexam) { addMedexamSheet(wb, parts.medexam, extra); summary.push(['Ежегодный медосмотр', parts.medexam]); }
  fillSummary(summarySheet, summary, filterText);
  const ymd = new Date().toISOString().slice(0, 10);
  const name = `${fileBase}_${ymd}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Cache-Control', 'no-store');
  await wb.xlsx.write(res);
  res.end();
}

module.exports = { sendMedWorkbook };
