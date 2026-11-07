import test from 'node:test';
import assert from 'node:assert/strict';
import { readImportFile, createTemplateCSV } from '../import.mjs';
import * as XLSX from '../vendor/xlsx-0.20.3.mjs';

const csvFile = (text, name = 'operations.csv') => new File([text], name, { type: 'text/csv' });
const makeExcel = (array, options = {}) => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(array, { cellDates: false }), 'Операции');
  if (options.date1904) workbook.Workbook = { WBProps: { date1904: true } };
  if (options.secondSheet) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Другие данные'], [123]]), 'Другой лист');
  if (options.formula) workbook.Sheets['Операции'].C2 = { t: 'n', v: 100, f: '50+50' };
  return new File([XLSX.write(workbook, { type: 'array', bookType: options.bookType ?? 'xlsx' })], options.bookType === 'biff8' ? 'operations.xls' : 'operations.xlsx');
};

test('Russian template imports exact integer kopecks and source/account names', async () => {
  const result = await readImportFile(csvFile(createTemplateCSV()));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.rows, [
    { date: '2026-10-03', kind: 'income', amount: 2000000, category: 'Зарплата', title: 'Первая часть зарплаты', sourceName: 'Зарплата', accountName: 'Основная карта' },
    { date: '2026-10-05', kind: 'expense', amount: 125050, category: 'Продукты', title: 'Покупки', accountName: 'Основная карта' }
  ]);
});

test('CSV quoted commas, quotes, multiline titles, CRLF and physical error line numbers', async () => {
  const result = await readImportFile(csvFile('Дата,Тип,Сумма,Описание\r\n2026-10-08,Расход,"1 234,56","Кофе, чай\r\nи ""сладости"""\r\n2026-02-30,Доход,100,Ошибка\r\n'));
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].amount, 123456);
  assert.equal(result.rows[0].title, 'Кофе, чай\nи "сладости"');
  assert.equal(result.errors[0].row, 4);
});

test('TSV, Excel sep directive, English columns and signed inference', async () => {
  const tabbed = await readImportFile(csvFile('date\tamount\tcategory\n2026-10-08\t-500.25\tКофе', 'test.tsv'));
  assert.deepEqual(tabbed.errors, []);
  assert.equal(tabbed.rows[0].kind, 'expense');
  assert.equal(tabbed.rows[0].amount, 50025);
  assert.equal(tabbed.warnings.length, 1);
  const excel = await readImportFile(csvFile('sep=;\nДата;Тип;Сумма\n08.10.2026;Перевод;1000'));
  assert.equal(excel.rows[0].kind, 'transfer');
  assert.equal(excel.rows[0].date, '2026-10-08');
  assert.deepEqual(excel.errors, []);
});

test('Windows-1251 CSV can be previewed without mangling Cyrillic', async () => {
  const text = 'Дата;Тип;Сумма\n2026-10-08;Расход;200';
  const bytes = Uint8Array.from([...text].map(character => {
    const code = character.charCodeAt(0);
    if (code >= 0x410 && code <= 0x44f) return code - 0x350;
    return code;
  }));
  const result = await readImportFile(new File([bytes], 'cp1251.csv'));
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].kind, 'expense');
  assert.match(result.warnings[0], /Windows-1251/);
});

test('ambiguous dates, malformed/zero amounts, conflicting signs and types are row errors', async () => {
  const result = await readImportFile(csvFile('Дата;Тип;Сумма\n10/08/2026;Доход;100\n2026-10-08;Расход;1,234\n2026-10-08;Доход;-100\n2026-10-08;Что-то;100\n2026-10-08;Расход;0\n2026-10-08;Расход;12 34,50\n2026-10-08;Расход;1250,567'));
  assert.equal(result.rows.length, 0);
  assert.deepEqual(result.errors.map(error => error.row), [2, 3, 4, 5, 6, 7, 8]);
});

test('grouped currencies, decimals, no-category rows, +/- types and transfers', async () => {
  const result = await readImportFile(csvFile('Дата;Тип;Сумма\n2026-10-08;Расход;1.234,56 ₽\n2026-10-08;Доход;1,234.56 RUB\n2026-10-08;Расход;(1 234,5)\n2026-10-08;-;-100\n2026-10-08;+;+100\n2026-10-08;Перевод;-400'));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows.map(row => row.amount), [123456, 123456, 123450, 10000, 10000, 40000]);
  assert.deepEqual(result.rows.map(row => row.kind), ['expense', 'income', 'expense', 'expense', 'income', 'transfer']);
  assert.equal(result.rows[0].category, '');
});

test('duplicate columns fail, duplicate rows warn but are not silently removed', async () => {
  const duplicateColumns = await readImportFile(csvFile('Дата;Сумма;amount\n2026-10-08;100;200'));
  assert.equal(duplicateColumns.errors.length, 1);
  assert.equal(duplicateColumns.rows.length, 0);
  const duplicates = await readImportFile(csvFile('Дата;Тип;Сумма\n2026-10-08;Расход;100\n2026-10-08;Расход;100'));
  assert.equal(duplicates.rows.length, 2);
  assert.match(duplicates.warnings[0], /повторяющиеся/);
});

test('preview validates text lengths against budget storage limits', async () => {
  const accepted = await readImportFile(csvFile('Дата;Тип;Сумма;Категория;Описание;Источник;Счёт\n2026-10-08;Доход;100;' + 'К'.repeat(160) + ';' + 'О'.repeat(300) + ';' + 'И'.repeat(160) + ';' + 'С'.repeat(160)));
  assert.deepEqual(accepted.errors, []);
  for (const field of ['Категория', 'Источник', 'Счёт', 'Описание']) {
    const maximum = field === 'Описание' ? 300 : 160;
    const rejected = await readImportFile(csvFile('Дата;Тип;Сумма;' + field + '\n2026-10-08;Доход;100;' + 'А'.repeat(maximum + 1)));
    assert.equal(rejected.rows.length, 0);
    assert.match(rejected.errors[0].message, new RegExp(String(maximum)));
  }
});

test('malformed CSV quotes reject the whole parse instead of changing columns', async () => {
  const unclosed = await readImportFile(csvFile('Дата;Сумма;Описание\n2026-10-08;100;"Не закрыто'));
  assert.equal(unclosed.rows.length, 0);
  assert.match(unclosed.errors[0].message, /Не закрыта/);
  const trailing = await readImportFile(csvFile('Дата;Сумма;Описание\n2026-10-08;100;"Название"oops'));
  assert.match(trailing.errors[0].message, /закрывающей/);
});

test('Excel numeric date and money, blank rows, optional fields and ignored sheets', async () => {
  const file = makeExcel([
    ['Дата', 'Тип', 'Сумма', 'Категория', 'Описание', 'Источник', 'Счёт'],
    [46303, 'Доход', 20000.12, 'Зарплата', 'Выплата', 'Работа', 'Карта'],
    [],
    ['08.10.2026', 'Расход', -1200.5, '', 'Покупка'],
    ['2026-02-30', 'Расход', 100]
  ], { secondSheet: true });
  const result = await readImportFile(file);
  assert.equal(result.rows[0].date, '2026-10-08');
  assert.equal(result.rows[0].amount, 2000012);
  assert.equal(result.rows[0].sourceName, 'Работа');
  assert.equal(result.rows[1].amount, 120050);
  assert.equal(result.errors[0].row, 5);
  assert.match(result.warnings[0], /первый непустой лист/);
});

test('Excel 1904 date system, native Date values and pre-header blank rows', async () => {
  const date1904 = await readImportFile(makeExcel([['Дата', 'Сумма'], [44841, 10]], { date1904: true }));
  assert.equal(date1904.rows[0].date, '2026-10-08');
  const date = await readImportFile(makeExcel([[], ['Дата', 'Сумма'], [new Date(2026, 9, 8), 12.3]]));
  assert.equal(date.rows[0].date, '2026-10-08');
  assert.equal(date.rows[0].amount, 1230);
});

test('Excel formulas and amounts with excessive precision do not use cached values', async () => {
  const formula = await readImportFile(makeExcel([['Дата', 'Тип', 'Сумма'], ['2026-10-08', 'Расход', 100]], { formula: true }));
  assert.equal(formula.rows.length, 0);
  assert.match(formula.errors[0].message, /Формулы/);
  const precision = await readImportFile(makeExcel([['Дата', 'Сумма'], ['2026-10-08', 12.345]]));
  assert.equal(precision.rows.length, 0);
  assert.match(precision.errors[0].message, /двумя знаками/);
});

test('legacy Excel .xls is parsed with Russian headings', async () => {
  const result = await readImportFile(makeExcel([['Дата', 'Тип', 'Сумма'], ['2026-10-08', 'Расход', 12.5]], { bookType: 'biff8' }));
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].amount, 1250);
});

test('Excel error cells are not accidentally interpreted as numeric amounts', async () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([['Дата', 'Сумма'], ['2026-10-08', 100]]);
  sheet.B2 = { t: 'e', v: 7 }; // #DIV/0! has a numeric raw value in XLSX
  XLSX.utils.book_append_sheet(workbook, sheet, 'Операции');
  const result = await readImportFile(new File([XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })], 'errors.xlsx'));
  assert.equal(result.rows.length, 0);
  assert.match(result.errors[0].message, /ошибкой Excel/);
});

test('more than 10000 data rows are rejected rather than truncated', async () => {
  const result = await readImportFile(csvFile('Дата;Тип;Сумма\n' + Array.from({ length: 10001 }, () => '2026-10-08;Расход;1').join('\n')));
  assert.equal(result.rows.length, 0);
  assert.match(result.errors[0].message, /10000/);
});

test('empty, unsupported, corrupt and large files return safe structured errors', async () => {
  for (const file of [csvFile(''), csvFile('something', 'data.pdf'), csvFile('not a workbook', 'data.xlsx'), { size: 11 * 1024 * 1024, arrayBuffer() { throw new Error('Must not read'); } }]) {
    const result = await readImportFile(file);
    assert.equal(result.rows.length, 0);
    assert.ok(result.errors.length);
    assert.ok(result.errors.every(error => typeof error.message === 'string'));
  }
});
