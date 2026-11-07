import { parseMoney, uid, applyCommand, validateState, ENTITIES, SCHEMA_VERSION } from './core.mjs';

const TYPE_LABELS = Object.freeze({
  debit: 'Дебетовая карта', credit: 'Кредитная карта', current: 'Расчётный счёт',
  joint: 'Совместный счёт', cash: 'Наличные', brokerage: 'Брокерский счёт',
  investment: 'Инвесткопилка', deposit: 'Вклад', savings: 'Накопительный счёт',
  other: 'Другое накопление'
});
const text = value => typeof value === 'string' ? value.trim() : '';
function requiredCategory(value) {
  const category = text(value);
  if (!category) throw new Error('Выберите категорию.');
  return category;
}

/** Read the category of a current or legacy income record without changing it. */
export function incomeCategory(state, record) {
  return text(record?.category) || text(state.sources.find(source => source.id === record?.sourceId)?.category) || 'Без категории';
}

/**
 * Build one atomic command for an income operation or planned income.
 * values: {category, source?, amount, date?, month?, title?, accountId?}.
 * amount is user-entered RUB text; source is an optional free-text name.
 * No source name or legacy category is ever interpreted as a monetary amount.
 */
export function incomeCommands(state, entity, values, recordId) {
  if (!['operations', 'incomePlans'].includes(entity)) throw new Error('Неизвестный вид дохода.');
  const category = requiredCategory(values.category);
  // Parse before resolving or creating a source. Source and income only exist
  // after the returned batch is successfully saved by the server.
  const amount = parseMoney(values.amount);
  const sourceName = text(values.source) || (entity === 'incomePlans' ? category : '');
  const commands = [];
  let sourceId = null;
  if (sourceName) {
    const source = state.sources.find(item => text(item.name) === sourceName && text(item.category) === category);
    sourceId = source?.id || uid('source');
    if (!source) commands.push({ type: 'upsert', entity: 'sources', record: { id: sourceId, name: sourceName, category } });
  }
  const id = recordId ?? uid(entity);
  const title = text(values.title);
  const record = entity === 'operations'
    ? { id, kind: 'income', amount, date: text(values.date), category, sourceId, accountId: text(values.accountId) || null, toAccountId: null, title }
    : { id, sourceId, month: text(values.month), amount, date: text(values.date) || null, title };
  commands.push({ type: 'upsert', entity, record });
  const command = { type: 'batch', commands };
  // Shared validation returns a copy. It never mutates state or persists data.
  applyCommand(state, command);
  return command;
}

/** A required bank and selected type determine the internal account name. */
export function accountName(state, bank, type, recordId) {
  const bankName = text(bank);
  if (!bankName) throw new Error('Укажите банк.');
  if (!Object.hasOwn(TYPE_LABELS, type)) throw new Error('Выберите тип счёта или карты.');
  const base = `${bankName} · ${TYPE_LABELS[type]}`;
  const occupied = new Set(state.accounts.filter(account => account.id !== recordId).map(account => account.name));
  const existing = state.accounts.find(account => account.id === recordId);
  const current = existing?.name;
  // Preserve legacy display names used by CSV imports when only the balance or
  // other non-identity fields are edited. A bank/type change derives a new name.
  if (current && text(existing.bank) === bankName && existing.type === type && !occupied.has(current)) return current;
  const suffix = current?.startsWith(base + ' (') && current.endsWith(')') ? current.slice(base.length + 2, -1) : '';
  const matchesBase = current === base || (/^\d+$/.test(suffix) && Number(suffix) >= 2);
  if (matchesBase && !occupied.has(current)) return current;
  let name = base, number = 2;
  while (occupied.has(name)) name = `${base} (${number++})`;
  if (name.length > 160 || bankName.length > 160) throw new Error('Название банка слишком длинное. Сократите его.');
  return name;
}

/** A category is required; a purchase/plan title and calendar date are optional. */
export function expensePlanRecord(values, id) {
  const record = {
    id: id ?? uid('expensePlans'), month: text(values.month), title: text(values.title),
    category: requiredCategory(values.category), amount: parseMoney(values.amount), date: text(values.date) || null
  };
  const validationState = {
    schemaVersion: SCHEMA_VERSION, currency: 'RUB',
    ...Object.fromEntries(ENTITIES.map(entity => [entity, entity === 'expensePlans' ? [record] : []]))
  };
  validateState(validationState);
  return record;
}
