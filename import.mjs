/**
 * Read-only import preview. Monetary amounts in the file are RUB; returned
 * amounts are positive integer kopecks. Nothing is written to budget storage.
 * SheetJS CE is vendored locally (Apache-2.0), see vendor/SheetJS-LICENSE.txt.
 */
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_ROWS = 10000;
const MAX_COLUMNS = 100;

const HEADERS = new Map([
  ['дата', 'date'], ['датаоперации', 'date'], ['датаплатежа', 'date'], ['date', 'date'],
  ['тип', 'kind'], ['типоперации', 'kind'], ['вид', 'kind'], ['видоперации', 'kind'], ['kind', 'kind'], ['type', 'kind'],
  ['сумма', 'amount'], ['суммаоперации', 'amount'], ['суммаврублях', 'amount'], ['amount', 'amount'],
  ['категория', 'category'], ['category', 'category'],
  ['описание', 'title'], ['назначение', 'title'], ['комментарий', 'title'], ['название', 'title'], ['title', 'title'], ['description', 'title'],
  ['источник', 'sourceName'], ['источникдохода', 'sourceName'], ['source', 'sourceName'], ['sourcename', 'sourceName'],
  ['счет', 'accountName'], ['карта', 'accountName'], ['account', 'accountName'], ['accountname', 'accountName']
]);

const TYPES = new Map([
  ['доход', 'income'], ['поступление', 'income'], ['пополнение', 'income'], ['income', 'income'], ['credit', 'income'], ['+', 'income'],
  ['расход', 'expense'], ['списание', 'expense'], ['покупка', 'expense'], ['expense', 'expense'], ['debit', 'expense'], ['-', 'expense'],
  ['перевод', 'transfer'], ['transfer', 'transfer'], ['междусвоими', 'transfer']
]);

const normalizeKey = value => String(value ?? '').replace(/^\uFEFF/, '').trim().toLowerCase().replace(/ё/g, 'е').replace(/[\s_\-().]/g, '');
const isBlank = value => value === undefined || value === null || String(value).trim() === '';
const failure = message => ({ rows: [], errors: [{ row: 0, message }], warnings: [] });

/** Download as text/csv;charset=utf-8. The BOM helps desktop Excel read Cyrillic. */
export function createTemplateCSV() {
  return '\uFEFFДата;Тип;Сумма;Категория;Описание;Источник;Счёт\r\n' +
    '2026-10-03;Доход;20000;Зарплата;Первая часть зарплаты;Зарплата;Основная карта\r\n' +
    '2026-10-05;Расход;1250,50;Продукты;Покупки;;Основная карта\r\n';
}

/**
 * @param {File|Blob & {name?: string}} file
 * @returns {Promise<{rows: Array<{date:string,kind:string,amount:number,category:string,title:string,sourceName?:string,accountName?:string}>,errors:Array<{row:number,message:string}>,warnings:string[]}>}
 */
export async function readImportFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function') return failure('Выберите файл CSV или Excel (.xlsx).');
  if (file.size > MAX_FILE_SIZE) return failure('Файл слишком большой. Максимальный размер — 10 МБ.');
  try {
    const buffer = await file.arrayBuffer();
    if (!buffer.byteLength) return failure('Файл пуст.');
    if (buffer.byteLength > MAX_FILE_SIZE) return failure('Файл слишком большой. Максимальный размер — 10 МБ.');
    const extension = String(file.name ?? '').toLowerCase().split('.').pop();
    if (['xlsx', 'xls'].includes(extension)) return await readExcel(buffer);
    if (!['csv', 'tsv', 'txt'].includes(extension)) return failure('Поддерживаются файлы CSV, TSV и Excel (.xlsx, .xls).');
    const warnings = [];
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch {
      text = new TextDecoder('windows-1251').decode(buffer);
      warnings.push('Файл прочитан в кодировке Windows-1251. Проверьте названия в предварительном просмотре.');
    }
    if (text.includes('\0')) return failure('Файл не похож на CSV. Сохраните таблицу в CSV UTF-8 или .xlsx.');
    let baseRow = 1;
    text = text.replace(/^\uFEFF/, '');
    const separatorLine = /^sep=([;,\t])(?:\r?\n|\r)/i.exec(text);
    const delimiter = separatorLine?.[1] ?? (extension === 'tsv' ? '\t' : detectDelimiter(text));
    if (separatorLine) { text = text.slice(separatorLine[0].length); baseRow = 2; }
    const parsed = parseDelimited(text, delimiter, baseRow);
    if (parsed.error) return { rows: [], errors: [parsed.error], warnings };
    return normalizeRecords(parsed.records, warnings);
  } catch (error) {
    return failure('Не удалось прочитать файл. Проверьте, что он не повреждён и не защищён паролем.');
  }
}

// Count separators only outside quoted fields. The header determines the CSV
// dialect, so decimal commas in data cannot override a semicolon header.
function detectDelimiter(text) {
  const counts = new Map([[';', 0], [',', 0], ['\t', 0]]);
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character === '"') {
      if (quoted && text[i + 1] === '"') { i++; continue; }
      quoted = !quoted;
    } else if (!quoted) {
      if ((character === '\n' || character === '\r') && [...counts.values()].some(Boolean)) break;
      if (counts.has(character)) counts.set(character, counts.get(character) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0][0];
}

function parseDelimited(text, delimiter, baseRow) {
  const records = [];
  let cells = [], cell = '', quoted = false, afterQuote = false;
  let line = baseRow, startRow = baseRow;
  const finishCell = () => { cells.push(cell); cell = ''; afterQuote = false; };
  const finishRow = () => {
    finishCell();
    records.push({ values: cells, row: startRow });
    cells = [];
  };
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quoted) {
      if (character === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { quoted = false; afterQuote = true; }
      } else if (character === '\r' || character === '\n') {
        if (character === '\r' && text[i + 1] === '\n') i++;
        cell += '\n'; line++;
      } else cell += character;
      continue;
    }
    if (character === delimiter) finishCell();
    else if (character === '\r' || character === '\n') {
      if (character === '\r' && text[i + 1] === '\n') i++;
      finishRow(); line++; startRow = line;
      if (records.length > MAX_ROWS + 20) return { error: { row: line, message: `В одном файле можно импортировать до ${MAX_ROWS} операций.` } };
    } else if (character === '"') {
      if (afterQuote || cell.trim()) return { error: { row: line, message: 'Некорректные кавычки в CSV. Поле с кавычками должно начинаться с двойной кавычки.' } };
      quoted = true; cell = '';
    } else if (afterQuote) {
      if (!/\s/.test(character)) return { error: { row: line, message: 'После закрывающей кавычки ожидается разделитель или конец строки.' } };
    } else cell += character;
    if (cells.length > MAX_COLUMNS) return { error: { row: line, message: 'Слишком много столбцов. Максимум — 100.' } };
  }
  if (quoted) return { error: { row: startRow, message: 'Не закрыта двойная кавычка в CSV.' } };
  if (cell || cells.length || afterQuote) finishRow();
  return { records };
}

async function readExcel(buffer) {
  const XLSX = await import('./vendor/xlsx-0.20.3.mjs');
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: false, cellNF: true, sheetRows: MAX_ROWS + 22 });
  const sheetNames = workbook.SheetNames.filter(name => workbook.Sheets[name]?.['!ref']);
  if (!sheetNames.length) return failure('В книге Excel нет данных.');
  const warnings = [];
  if (sheetNames.length > 1) warnings.push(`Прочитан первый непустой лист «${sheetNames[0]}». Остальные листы не импортированы.`);
  const worksheet = workbook.Sheets[sheetNames[0]];
  const range = XLSX.utils.decode_range(worksheet['!ref']);
  const fullRange = worksheet['!fullref'] ? XLSX.utils.decode_range(worksheet['!fullref']) : range;
  if (fullRange.e.r - fullRange.s.r > MAX_ROWS + 20) return failure(`В одном файле можно импортировать до ${MAX_ROWS} операций.`);
  if (range.e.c - range.s.c >= MAX_COLUMNS) return failure('Слишком много столбцов. Максимум — 100.');
  // Retain actual raw serial dates and the book's date system. sheet_to_json
  // converts date-formatted numeric cells to local Date objects even with raw:
  // true, which can change the calendar day and loses the 1904-book context.
  const records = [];
  for (let row = range.s.r; row <= range.e.r; row++) {
    const record = { row: row + 1, values: [], formulas: new Set(), cellErrors: new Set() };
    for (let column = range.s.c; column <= range.e.c; column++) {
      const cell = worksheet[XLSX.utils.encode_cell({ r: row, c: column })];
      record.values.push(cell?.v ?? '');
      if (cell?.f) record.formulas.add(column - range.s.c);
      if (cell?.t === 'e') record.cellErrors.add(column - range.s.c);
    }
    records.push(record);
  }
  return normalizeRecords(records, warnings, {
    parseExcelDate: serial => {
      const parsed = XLSX.SSF.parse_date_code(serial, { date1904: !!workbook.Workbook?.WBProps?.date1904 });
      return parsed ? [parsed.y, parsed.m, parsed.d] : null;
    }
  });
}

function normalizeRecords(records, warnings, options = {}) {
  const errors = [], rows = [];
  const nonempty = records.filter(record => record.values.some(value => !isBlank(value)));
  if (!nonempty.length) return failure('В файле нет данных.');
  const header = nonempty[0];
  const columns = header.values.map(value => HEADERS.get(normalizeKey(value)));
  if (!columns.includes('date') || !columns.includes('amount')) return {
    rows, errors: [{ row: header.row, message: 'В первой строке нужны заголовки «Дата» и «Сумма». Используйте шаблон импорта.' }], warnings
  };
  const found = new Set();
  columns.forEach((key, index) => {
    if (key && found.has(key)) errors.push({ row: header.row, message: `Повторяется столбец «${header.values[index]}». Оставьте один столбец этого типа.` });
    if (key) found.add(key);
  });
  if (errors.length) return { rows, errors, warnings };
  const unknown = header.values.filter((value, index) => !isBlank(value) && !columns[index]);
  if (unknown.length) warnings.push(`Неизвестные столбцы пропущены: ${unknown.map(value => String(value).slice(0, 80)).join(', ')}.`);
  if (nonempty.length - 1 > MAX_ROWS) return failure(`В одном файле можно импортировать до ${MAX_ROWS} операций.`);
  let inferredTypes = false, duplicates = 0;
  const seen = new Set();
  for (const record of nonempty.slice(1)) {
    if (record.values.length > columns.length && record.values.slice(columns.length).some(value => !isBlank(value))) {
      errors.push({ row: record.row, message: 'В строке больше значений, чем заголовков. Проверьте разделители и кавычки.' }); continue;
    }
    const raw = Object.create(null);
    let hasFormula = false, hasCellError = false;
    columns.forEach((key, column) => {
      if (!key) return;
      raw[key] = record.values[column];
      if (record.formulas?.has(column)) hasFormula = true;
      if (record.cellErrors?.has(column)) hasCellError = true;
    });
    try {
      if (hasFormula) throw new Error('Формулы не импортируются. Замените формулы готовыми значениями.');
      if (hasCellError) throw new Error('В строке есть ячейка с ошибкой Excel. Исправьте её перед импортом.');
      const date = parseDate(raw.date, options.parseExcelDate);
      const signedAmount = parseAmount(raw.amount);
      let kind;
      if (isBlank(raw.kind)) { kind = signedAmount < 0 ? 'expense' : 'income'; inferredTypes = true; }
      else {
        const typeText = String(raw.kind).trim();
        kind = TYPES.get(typeText === '-' || typeText === '+' ? typeText : normalizeKey(typeText));
        if (!kind) throw new Error('Тип должен быть «Доход», «Расход» или «Перевод».');
      }
      if (kind === 'income' && signedAmount < 0) throw new Error('У дохода отрицательная сумма. Исправьте сумму или выберите тип «Расход».');
      const row = { date, kind, amount: Math.abs(signedAmount), category: cleanText(raw.category, 'Категория'), title: cleanText(raw.title, 'Описание') };
      if (!isBlank(raw.sourceName)) row.sourceName = cleanText(raw.sourceName, 'Источник');
      if (!isBlank(raw.accountName)) row.accountName = cleanText(raw.accountName, 'Счёт');
      const signature = JSON.stringify(row);
      if (seen.has(signature)) duplicates++;
      seen.add(signature);
      rows.push(row);
    } catch (error) { errors.push({ row: record.row, message: error.message }); }
  }
  if (inferredTypes) warnings.push('В строках без типа положительная сумма считается доходом, отрицательная — расходом. Проверьте направление операций.');
  if (duplicates) warnings.push(`В файле есть повторяющиеся операции: ${duplicates}. Они оставлены в предварительном просмотре — проверьте их перед импортом.`);
  if (!rows.length && !errors.length) errors.push({ row: header.row, message: 'После заголовков нет операций.' });
  return { rows, errors, warnings };
}

function cleanText(value, label) {
  const text = String(value ?? '').trim();
  const maximum = label === 'Описание' ? 300 : 160;
  if (text.length > maximum) throw new Error(`Поле «${label}» слишком длинное. Максимум — ${maximum} символов.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error(`В поле «${label}» есть недопустимые символы.`);
  return text;
}

function parseDate(value, parseExcelDate) {
  let parts;
  if (typeof value === 'number' && parseExcelDate && Number.isFinite(value) && value >= 0) parts = parseExcelDate(value);
  else {
    const text = String(value ?? '').trim();
    let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (match) parts = [Number(match[1]), Number(match[2]), Number(match[3])];
    else if ((match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text))) parts = [Number(match[3]), Number(match[2]), Number(match[1])];
  }
  if (!parts) throw new Error('Дата должна быть в формате ГГГГ-ММ-ДД или ДД.ММ.ГГГГ.');
  const [year, month, day] = parts;
  const actual = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || year > 9999 || actual.getUTCFullYear() !== year || actual.getUTCMonth() + 1 !== month || actual.getUTCDate() !== day) throw new Error('Некорректная дата. Проверьте день, месяц и год.');
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseAmount(value) {
  if (typeof value === 'number') {
    const kopecks = Math.round(value * 100);
    if (!Number.isFinite(value) || !Number.isSafeInteger(kopecks) || Math.abs(value * 100 - kopecks) > 0.00001) throw new Error('Сумма должна быть числом с максимум двумя знаками после запятой.');
    if (!kopecks) throw new Error('Сумма операции должна быть больше нуля.');
    return kopecks;
  }
  let text = String(value ?? '').trim().replace(/\u2212/g, '-').replace(/\s*(?:₽|руб\.?|рублей|rub)$/iu, '').trim();
  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1).trim(); }
  if (/^[+-]/.test(text)) {
    if (negative) throw new Error('В сумме одновременно скобки и знак. Укажите один знак суммы.');
    negative = text[0] === '-'; text = text.slice(1).trim();
  }
  if (!text || !/^[\d.,\s\u00a0\u202f]+$/.test(text)) throw new Error('Некорректная сумма. Пример: 1250,50 или 1 250,50.');
  if (/\s/.test(text)) {
    const [integerPart] = text.split(/[.,]/);
    if (!/^\d{1,3}(?:[\s\u00a0\u202f]\d{3})+$/.test(integerPart)) throw new Error('Некорректные разделители тысяч в сумме. Пример: 1 250,50.');
    text = text.replace(/[\s\u00a0\u202f]/g, '');
  }
  const dot = text.includes('.'), comma = text.includes(',');
  if (dot && comma) {
    const decimal = text.lastIndexOf('.') > text.lastIndexOf(',') ? '.' : ',';
    const grouping = decimal === '.' ? ',' : '.';
    const pieces = text.split(decimal);
    const groupingPattern = grouping === '.' ? /^\d{1,3}(?:\.\d{3})+$/ : /^\d{1,3}(?:,\d{3})+$/;
    if (pieces.length !== 2 || !groupingPattern.test(pieces[0]) || !/^\d{1,2}$/.test(pieces[1])) throw new Error('Неоднозначная сумма. Используйте формат 1250,50 без разделителей тысяч.');
    text = pieces[0].split(grouping).join('') + '.' + pieces[1];
  } else if (dot || comma) {
    const separator = dot ? '.' : ',';
    const pieces = text.split(separator);
    if (pieces.length === 2 && /^\d{1,2}$/.test(pieces[1])) text = pieces[0] + '.' + pieces[1];
    else if (pieces.length > 2 && /^\d{1,3}$/.test(pieces[0]) && pieces.slice(1).every(part => /^\d{3}$/.test(part))) text = pieces.join('');
    else throw new Error('Неоднозначная сумма. Используйте максимум два знака после запятой; тысячи разделяйте пробелом.');
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error('Некорректная сумма. Пример: 1250,50.');
  const [whole, fraction = ''] = text.split('.');
  const kopecks = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(kopecks)) throw new Error('Сумма слишком большая.');
  if (!kopecks) throw new Error('Сумма операции должна быть больше нуля.');
  return negative ? -kopecks : kopecks;
}
