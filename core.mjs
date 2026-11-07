/** Shared budget domain. All monetary values are integer kopecks. */
export const SCHEMA_VERSION = 3;
export const ENTITIES = Object.freeze([
  'accounts', 'sources', 'incomePlans', 'expensePlans', 'operations',
  'goals', 'contributions', 'notes', 'events', 'snapshots',
]);

const ACCOUNT_TYPES = new Set(['debit', 'credit', 'current', 'joint', 'cash', 'brokerage', 'investment', 'deposit', 'savings', 'other']);
const OPERATION_KINDS = new Set(['income', 'expense', 'transfer']);
const EVENT_KINDS = new Set(['reminder', 'income', 'expense', 'purchase']);
const MAX_RECORDS_PER_ENTITY = 50000;
const MAX_TOTAL_RECORDS = 100000;
const RECORD_KEYS = {
  accounts: ['id', 'name', 'type', 'bank', 'balance', 'date', 'share'],
  sources: ['id', 'name', 'category'],
  incomePlans: ['id', 'sourceId', 'month', 'amount', 'date', 'title'],
  expensePlans: ['id', 'month', 'title', 'category', 'amount', 'date'],
  operations: ['id', 'kind', 'amount', 'date', 'category', 'sourceId', 'accountId', 'toAccountId', 'title'],
  goals: ['id', 'title', 'period', 'periodKey', 'target', 'dueDate', 'accountId'],
  contributions: ['id', 'goalId', 'amount', 'date', 'note'],
  notes: ['id', 'date', 'month', 'title', 'text'],
  events: ['id', 'date', 'title', 'kind', 'amount', 'notes'],
  snapshots: ['id', 'month', 'date', 'income', 'expense', 'planIncome', 'planExpense', 'note'],
};
const currencyFormatter = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', minimumFractionDigits: 0, maximumFractionDigits: 2 });
const monthFormatter = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const clone = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
const fail = (path, message) => { throw new Error(`${path}: ${message}`); };
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export function uid(prefix = 'item') {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${id}`;
}

function assertText(value, path, nonempty = false) {
  if (typeof value !== 'string' || (nonempty && !value.trim())) fail(path, nonempty ? 'требуется непустой текст' : 'требуется текст');
  const field = path.slice(path.lastIndexOf('.') + 1);
  const maximum = ['text', 'note', 'notes'].includes(field) ? 20000 : field === 'title' ? 300 : 160;
  if (value.length > maximum) fail(path, `текст длиннее ${maximum} символов`);
}

function assertMoney(value, path, minimum = null) {
  if (!Number.isSafeInteger(value)) fail(path, 'требуется целая безопасная сумма в копейках');
  if (minimum !== null && value < minimum) fail(path, `сумма должна быть не меньше ${minimum} коп.`);
}

function daysInMonth(year, month) {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isMonth(value) {
  return typeof value === 'string' && /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function isDate(value) {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  return day <= daysInMonth(year, month);
}

function assertDate(value, path, nullable = false) {
  if (nullable && value === null) return;
  if (!isDate(value)) fail(path, 'требуется существующая дата ГГГГ-ММ-ДД');
}

function assertMonth(value, path) {
  if (!isMonth(value)) fail(path, 'требуется месяц ГГГГ-ММ');
}

function monthBounds(month) {
  assertMonth(month, 'month');
  const [year, number] = month.split('-').map(Number);
  return { from: `${month}-01`, to: `${month}-${String(daysInMonth(year, number)).padStart(2, '0')}` };
}

function assertRange(from, to) {
  assertDate(from, 'from');
  assertDate(to, 'to');
  if (from > to) fail('range', 'начало периода позже окончания');
}

function assertReference(value, path, ids, nullable = true) {
  if (nullable && value === null) return;
  assertText(value, path, true);
  if (!ids.has(value)) fail(path, 'связанная запись не существует');
}

function checkedSum(left, right) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) fail('total', 'итоговая сумма выходит за безопасный диапазон');
  return result;
}

/** Accepts Russian amounts such as "65 000,50 ₽"; never guesses grouping commas. */
export function parseMoney(value) {
  if (typeof value !== 'string') fail('amount', 'введите сумму текстом');
  if (value.length > 160) fail('amount', 'сумма слишком длинная');
  const text = value.trim().replace(/^(?:₽|руб\.?|rub)\s*/i, '').replace(/\s*(?:₽|руб\.?|rub)$/i, '').replace(/[\s\u00a0\u202f]/g, '').replace(/\u2212/g, '-');
  const match = /^([+-]?)(\d+)(?:[.,](\d{1,2}))?$/.exec(text);
  if (!match) fail('amount', 'введите сумму, например 1 250,50');
  const sign = match[1] === '-' ? -1n : 1n;
  const result = sign * (BigInt(match[2]) * 100n + BigInt((match[3] ?? '').padEnd(2, '0') || '0'));
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) fail('amount', 'сумма слишком велика');
  return Number(result);
}

export function money(amount) {
  assertMoney(amount, 'amount');
  return currencyFormatter.format(amount / 100);
}

export function monthLabel(month) {
  assertMonth(month, 'month');
  const result = monthFormatter.format(new Date(`${month}-15T12:00:00.000Z`)).replace(/\s*г\.$/, '');
  return result.charAt(0).toUpperCase() + result.slice(1);
}

/** Validation never changes the passed object. Throws with a field path on failure. */
export function validateState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) fail('state', 'требуется объект бюджета');
  if (state.schemaVersion !== SCHEMA_VERSION) fail('schemaVersion', `поддерживается версия ${SCHEMA_VERSION}`);
  if (state.currency !== 'RUB') fail('currency', 'сейчас поддерживаются только рубли');
  for (const key of Object.keys(state)) if (!['schemaVersion', 'currency', ...ENTITIES].includes(key)) fail(key, 'неизвестное поле бюджета');
  const ids = {};
  let totalRecords = 0;
  for (const entity of ENTITIES) {
    if (!Array.isArray(state[entity])) fail(entity, 'требуется список');
    totalRecords += state[entity].length;
    if (state[entity].length > MAX_RECORDS_PER_ENTITY || totalRecords > MAX_TOTAL_RECORDS) fail(entity, 'слишком много записей в резервной копии');
    ids[entity] = new Set();
    state[entity].forEach((record, index) => {
      const path = `${entity}[${index}]`;
      if (!record || typeof record !== 'object' || Array.isArray(record)) fail(path, 'требуется запись');
      for (const key of Object.keys(record)) if (!RECORD_KEYS[entity].includes(key)) fail(`${path}.${key}`, 'неизвестное поле записи');
      assertText(record.id, `${path}.id`, true);
      if (ids[entity].has(record.id)) fail(`${path}.id`, 'идентификатор повторяется');
      ids[entity].add(record.id);
    });
  }
  state.accounts.forEach((record, index) => {
    const path = `accounts[${index}]`;
    assertText(record.name, `${path}.name`, true);
    if (!ACCOUNT_TYPES.has(record.type)) fail(`${path}.type`, 'неизвестный тип счёта');
    assertText(record.bank, `${path}.bank`);
    assertMoney(record.balance, `${path}.balance`, record.type === 'credit' ? 0 : null);
    assertDate(record.date, `${path}.date`);
    if (record.type === 'joint' || record.share !== undefined) {
      if (typeof record.share !== 'number' || !Number.isFinite(record.share) || record.share < 0 || record.share > 100) fail(`${path}.share`, 'доля должна быть от 0 до 100');
    }
  });
  state.sources.forEach((record, index) => {
    assertText(record.name, `sources[${index}].name`, true);
    assertText(record.category, `sources[${index}].category`);
  });
  for (const entity of ['incomePlans', 'expensePlans']) {
    state[entity].forEach((record, index) => {
      const path = `${entity}[${index}]`;
      assertMonth(record.month, `${path}.month`);
      assertMoney(record.amount, `${path}.amount`, 0);
      assertDate(record.date, `${path}.date`, true);
      if (record.date !== null && record.date.slice(0, 7) !== record.month) fail(`${path}.date`, 'дата должна относиться к месяцу плана');
      assertText(record.title, `${path}.title`);
      if (entity === 'incomePlans') assertReference(record.sourceId, `${path}.sourceId`, ids.sources, false);
      else assertText(record.category, `${path}.category`);
    });
  }
  state.operations.forEach((record, index) => {
    const path = `operations[${index}]`;
    if (!OPERATION_KINDS.has(record.kind)) fail(`${path}.kind`, 'неизвестный вид операции');
    assertMoney(record.amount, `${path}.amount`, 1);
    assertDate(record.date, `${path}.date`);
    assertText(record.category, `${path}.category`);
    assertText(record.title, `${path}.title`);
    assertReference(record.sourceId, `${path}.sourceId`, ids.sources);
    assertReference(record.accountId, `${path}.accountId`, ids.accounts);
    assertReference(record.toAccountId, `${path}.toAccountId`, ids.accounts);
    if (record.kind === 'transfer' && record.accountId !== null && record.accountId === record.toAccountId) fail(`${path}.toAccountId`, 'выберите другой счёт для перевода');
  });
  state.goals.forEach((record, index) => {
    const path = `goals[${index}]`;
    assertText(record.title, `${path}.title`, true);
    if (record.period !== 'month' && record.period !== 'year') fail(`${path}.period`, 'выберите месяц или год');
    if (record.period === 'month') assertMonth(record.periodKey, `${path}.periodKey`);
    else if (typeof record.periodKey !== 'string' || !/^(?!0000)\d{4}$/.test(record.periodKey)) fail(`${path}.periodKey`, 'требуется год ГГГГ');
    assertMoney(record.target, `${path}.target`, 1);
    assertDate(record.dueDate, `${path}.dueDate`, true);
    assertReference(record.accountId, `${path}.accountId`, ids.accounts);
  });
  state.contributions.forEach((record, index) => {
    const path = `contributions[${index}]`;
    assertReference(record.goalId, `${path}.goalId`, ids.goals, false);
    assertMoney(record.amount, `${path}.amount`, 1);
    assertDate(record.date, `${path}.date`);
    assertText(record.note, `${path}.note`);
  });
  state.notes.forEach((record, index) => {
    const path = `notes[${index}]`;
    assertDate(record.date, `${path}.date`);
    assertMonth(record.month, `${path}.month`);
    assertText(record.title, `${path}.title`);
    assertText(record.text, `${path}.text`);
  });
  state.events.forEach((record, index) => {
    const path = `events[${index}]`;
    assertDate(record.date, `${path}.date`);
    assertText(record.title, `${path}.title`, true);
    if (!EVENT_KINDS.has(record.kind)) fail(`${path}.kind`, 'неизвестный вид события');
    if (record.amount !== null) assertMoney(record.amount, `${path}.amount`, 0);
    assertText(record.notes, `${path}.notes`);
  });
  state.snapshots.forEach((record, index) => {
    const path = `snapshots[${index}]`;
    assertMonth(record.month, `${path}.month`);
    assertDate(record.date, `${path}.date`);
    for (const key of ['income', 'expense', 'planIncome', 'planExpense']) assertMoney(record[key], `${path}.${key}`, 0);
    assertText(record.note, `${path}.note`);
  });
  return state;
}

const defaults = {
  accounts: { bank: '', balance: 0, share: 100 },
  sources: { category: '' },
  incomePlans: { amount: 0, date: null, title: '' },
  expensePlans: { amount: 0, date: null, title: '', category: '' },
  operations: { title: '', category: '', sourceId: null, accountId: null, toAccountId: null },
  goals: { dueDate: null, accountId: null },
  contributions: { note: '' },
  notes: { title: '', text: '' },
  events: { kind: 'reminder', amount: null, notes: '' },
  snapshots: { note: '' },
};

/** Returns a validated copy. Account balances are only changed by account edits. */
export function applyCommand(state, command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) fail('command', 'требуется команда');
  if (command.type === 'restore') return validateState(clone(command.state));
  validateState(state);
  const next = clone(state);
  if (command.type === 'batch') {
    if (!Array.isArray(command.commands) || command.commands.length > MAX_RECORDS_PER_ENTITY) fail('commands', 'требуется список не более 50 000 команд');
    for (const item of command.commands) applySimpleCommand(next, item);
  } else applySimpleCommand(next, command);
  return validateState(next);
}

function applySimpleCommand(next, command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) fail('command', 'требуется команда');
  if (!ENTITIES.includes(command.entity)) fail('entity', 'неизвестный список');
  const { entity } = command;
  if (command.type === 'upsert') {
    if (!command.record || typeof command.record !== 'object' || Array.isArray(command.record)) fail('record', 'требуется запись');
    const record = clone(command.record);
    if (!own(record, 'id')) record.id = uid(entity);
    assertText(record.id, 'record.id', true);
    const index = next[entity].findIndex(item => item.id === record.id);
    const updated = { ...defaults[entity], ...(index >= 0 ? next[entity][index] : {}), ...record };
    if (index >= 0) next[entity][index] = updated;
    else next[entity].push(updated);
  } else if (command.type === 'delete') {
    assertText(command.id, 'id', true);
    if (!next[entity].some(item => item.id === command.id)) fail('id', 'запись не найдена');
    next[entity] = next[entity].filter(item => item.id !== command.id);
    if (entity === 'sources') {
      next.incomePlans = next.incomePlans.filter(item => item.sourceId !== command.id);
      next.operations.forEach(item => { if (item.sourceId === command.id) item.sourceId = null; });
    }
    if (entity === 'accounts') {
      next.operations.forEach(item => {
        if (item.accountId === command.id) item.accountId = null;
        if (item.toAccountId === command.id) item.toAccountId = null;
      });
      next.goals.forEach(item => { if (item.accountId === command.id) item.accountId = null; });
    }
    if (entity === 'goals') next.contributions = next.contributions.filter(item => item.goalId !== command.id);
  } else fail('type', 'неизвестная команда');
}

function addTo(object, key, amount) {
  // defineProperty keeps arbitrary user category names, including __proto__, safe.
  Object.defineProperty(object, key, { value: checkedSum(own(object, key) ? object[key] : 0, amount), writable: true, enumerable: true, configurable: true });
}

/** Facts come only from operations; snapshots are archive records, never added. */
export function rangeSummary(state, from, to) {
  validateState(state);
  assertRange(from, to);
  const result = {
    income: 0, expense: 0, net: 0, planIncome: 0, planExpense: 0, plannedNet: 0, delta: 0,
    incomeBySource: {}, expenseByCategory: {},
    unallocatedPlan: { count: 0, amount: 0, incomeCount: 0, incomeAmount: 0, expenseCount: 0, expenseAmount: 0 },
  };
  const within = date => date >= from && date <= to;
  for (const operation of state.operations) {
    if (!within(operation.date)) continue;
    if (operation.kind === 'income') {
      result.income = checkedSum(result.income, operation.amount);
      addTo(result.incomeBySource, operation.sourceId || 'none', operation.amount);
    } else if (operation.kind === 'expense') {
      result.expense = checkedSum(result.expense, operation.amount);
      addTo(result.expenseByCategory, operation.category.trim() || 'Без категории', operation.amount);
    }
  }
  for (const [entity, total, kind] of [['incomePlans', 'planIncome', 'income'], ['expensePlans', 'planExpense', 'expense']]) {
    for (const plan of state[entity]) {
      if (plan.date !== null) {
        if (within(plan.date)) result[total] = checkedSum(result[total], plan.amount);
        continue;
      }
      const month = monthBounds(plan.month);
      if (month.to < from || month.from > to) continue;
      if (from <= month.from && to >= month.to) result[total] = checkedSum(result[total], plan.amount);
      else {
        result.unallocatedPlan.count += 1;
        result.unallocatedPlan.amount = checkedSum(result.unallocatedPlan.amount, plan.amount);
        result.unallocatedPlan[`${kind}Count`] += 1;
        result.unallocatedPlan[`${kind}Amount`] = checkedSum(result.unallocatedPlan[`${kind}Amount`], plan.amount);
      }
    }
  }
  result.net = checkedSum(result.income, -result.expense);
  result.plannedNet = checkedSum(result.planIncome, -result.planExpense);
  result.delta = checkedSum(result.net, -result.plannedNet);
  return result;
}

export function monthSummary(state, month) {
  const { from, to } = monthBounds(month);
  return rangeSummary(state, from, to);
}

/** Normalized calendar entries; undated plans never receive an invented date. */
export function calendarEvents(state, from, to) {
  validateState(state);
  assertRange(from, to);
  const result = [];
  const sourceNames = new Map(state.sources.map(source => [source.id, source.name]));
  const goalNames = new Map(state.goals.map(goal => [goal.id, goal.title]));
  const add = (entity, record, date, kind, amount, title, planned) => {
    if (date === null || date < from || date > to) return;
    result.push({ id: `${entity}:${record.id}`, date, title, kind, amount, entity, recordId: record.id, planned });
  };
  for (const record of state.incomePlans) add('incomePlans', record, record.date, 'income', record.amount, record.title || sourceNames.get(record.sourceId) || 'Доход по плану', true);
  for (const record of state.expensePlans) add('expensePlans', record, record.date, 'expense', record.amount, record.title || record.category || 'Расход по плану', true);
  for (const record of state.operations) add('operations', record, record.date, record.kind, record.amount, record.title || (record.kind === 'income' ? sourceNames.get(record.sourceId) || 'Доход' : record.kind === 'transfer' ? 'Перевод между счетами' : record.category || 'Расход'), false);
  for (const record of state.events) add('events', record, record.date, record.kind, record.amount, record.title, true);
  for (const record of state.goals) add('goals', record, record.dueDate, 'goal', record.target, record.title, true);
  for (const record of state.contributions) add('contributions', record, record.date, 'contribution', record.amount, `На цель: ${goalNames.get(record.goalId)}`, false);
  for (const record of state.notes) add('notes', record, record.date, 'note', null, record.title || 'Заметка', false);
  for (const record of state.snapshots) add('snapshots', record, record.date, 'snapshot', null, `Срез: ${monthLabel(record.month)}`, false);
  return result.sort((a, b) => a.date.localeCompare(b.date) || Number(a.planned) - Number(b.planned) || a.id.localeCompare(b.id));
}

/** Manual current balances only. Joint accounts count the owner's share once. */
export function accountTotals(state) {
  validateState(state);
  const result = { available: 0, reserve: 0, investments: 0, debt: 0, totalAssets: 0, netWorth: 0 };
  for (const account of state.accounts) {
    if (account.type === 'credit') { result.debt = checkedSum(result.debt, account.balance); continue; }
    const balance = account.type === 'joint' ? ownedJointBalance(account.balance, account.share) : account.balance;
    assertMoney(balance, 'accountTotal');
    if (account.type === 'brokerage' || account.type === 'investment') result.investments = checkedSum(result.investments, balance);
    else if (account.type === 'savings' || account.type === 'deposit' || account.type === 'other') result.reserve = checkedSum(result.reserve, balance);
    else result.available = checkedSum(result.available, balance);
  }
  result.totalAssets = checkedSum(checkedSum(result.available, result.reserve), result.investments);
  result.netWorth = checkedSum(result.totalAssets, -result.debt);
  return result;
}

function ownedJointBalance(balance, share) {
  // Exact rational arithmetic avoids dropping kopecks for large balances or a fractional share.
  const [, whole, fraction = '', exponent = '0'] = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(share));
  const power = Number(exponent) - fraction.length - 2;
  let numerator = BigInt(balance) * BigInt(whole + fraction);
  const denominator = power < 0 ? 10n ** BigInt(-power) : 1n;
  if (power > 0) numerator *= 10n ** BigInt(power);
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute + denominator / 2n) / denominator;
  return Number(negative ? -rounded : rounded);
}

/** A new browser starts with an empty budget, never personal or demo records. */
export function seedState(){return validateState({schemaVersion:SCHEMA_VERSION,currency:'RUB',...Object.fromEntries(ENTITIES.map(entity=>[entity,[]]))})}
