import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pieParts, donutChart, movementChart, categoryChart,
  readChartTypes, saveChartTypes, chartTypeControls
} from '../charts.mjs';

const totalsInMarkup = html => [...html.matchAll(/data-total="(\d+)"/g)].map(match => Number(match[1]));
const amountsInMarkup = html => [...html.matchAll(/data-value="(\d+)"/g)].map(match => Number(match[1]));
const memoryStorage = initial => {
  const records = new Map(Object.entries(initial ?? {}));
  return { records, getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value) };
};

test('pie preserves exact kopecks and labels without mutating input', () => {
  const rows = [{ label: 'День 1', value: 1 }, { label: 'День 2', value: 2 }, { label: 'День 3', value: 7 }, { label: 'Пусто', value: 0 }];
  const before = structuredClone(rows);
  const { total, parts } = pieParts(rows);
  assert.equal(total, 10);
  assert.deepEqual(parts.map(part => [part.label, part.value]), [['День 1', 1], ['День 2', 2], ['День 3', 7]]);
  assert.equal(parts.reduce((sum, part) => sum + part.value, 0), total);
  assert.equal(parts.reduce((sum, part) => sum + part.size, 0), 100);
  assert.deepEqual(parts.map(part => part.fraction), [0.1, 0.2, 0.7]);
  assert.deepEqual(rows, before);
});

test('empty and single-value charts have defined geometry without NaN', () => {
  assert.deepEqual(pieParts([{ label: 'Ноль', value: 0 }, { label: 'Не учитывается', value: -100 }]), { total: 0, parts: [] });
  const empty = donutChart([], 'Доходы', 'Нет доходов');
  assert.match(empty, /Нет доходов/);
  assert.deepEqual(totalsInMarkup(empty), []);
  assert.doesNotMatch(empty, /NaN|Infinity/);
  const { total, parts } = pieParts([{ label: 'Один день', value: 12345 }]);
  assert.equal(total, 12345);
  assert.equal(parts[0].size, 100);
  assert.equal(parts[0].offset, 0);
  assert.equal(parts[0].fraction, 1);
  assert.deepEqual(totalsInMarkup(donutChart([{ label: 'Один день', value: 12345 }], 'Доходы', 'Нет')), [12345]);
});

test('invalid positive amounts and unsafe accumulated total are rejected', () => {
  for (const value of [1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => pieParts([{ label: 'Ошибка', value }]));
  assert.throws(() => pieParts([{ label: 'Большая сумма', value: Number.MAX_SAFE_INTEGER }, { label: 'Ещё копейка', value: 1 }]));
});

test('large safe monetary totals never produce negative or overfull SVG segments', () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({ label: String(index), value: index === 9 ? 1 : Math.floor(9007199254740000 / 9) }));
  const { total, parts } = pieParts(rows);
  assert.ok(Number.isSafeInteger(total));
  assert.equal(parts.reduce((sum, part) => sum + part.value, 0), total);
  for (const part of parts) {
    assert.ok(Number.isFinite(part.size) && part.size >= 0 && part.size <= 100, `Invalid SVG segment size: ${part.size}`);
    assert.ok(Number.isFinite(part.offset) && part.offset >= 0 && part.offset <= 100, `Invalid SVG segment offset: ${part.offset}`);
  }
  assert.ok(Math.abs(parts.at(-1).offset + parts.at(-1).size - 100) < 1e-12);
});

test('movement pies use the complete date grouping even when bars are truncated', () => {
  const visible = [{ key: '2026-01-01', income: 100, expense: 0 }];
  const complete = [...visible, { key: '2028-10-08', income: 500, expense: 250 }];
  const html = movementChart(visible, { type: 'pie', group: 'days', pieGroups: complete, truncated: true });
  assert.deepEqual(totalsInMarkup(html), [600, 250]);
  assert.equal(amountsInMarkup(html).reduce((sum, value) => sum + value, 0), 850);
  assert.match(html, /08\.10\.2028/);
  const monthly = movementChart([], { type: 'pie', group: 'months', pieGroups: [{ key: '2026-10', income: 500, expense: 250 }] });
  assert.deepEqual(totalsInMarkup(monthly), [500, 250]);
  assert.match(monthly, /по месяцам/);
  const bars = movementChart(visible, { type: 'bar', truncated: true });
  assert.match(bars, /366 дней/);
});

test('category totals include arbitrary user names and markup is escaped', () => {
  const payload = '<img src=x onerror="alert(1)"> & </title><script>alert(2)</script>';
  const categories = Object.create(null);
  categories.__proto__ = 1200;
  categories.constructor = 3400;
  categories[payload] = 100;
  const html = categoryChart(categories, 'pie');
  assert.deepEqual(totalsInMarkup(html), [4700]);
  assert.equal(amountsInMarkup(html).reduce((sum, value) => sum + value, 0), 4700);
  assert.match(html, /__proto__/);
  assert.match(html, /constructor/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img|<script/);
  const empty = donutChart([], payload, payload);
  assert.doesNotMatch(empty, /<img|<script/);
  assert.match(chartTypeControls('categories', 'pie', payload), /&lt;img/);
  assert.doesNotMatch(categoryChart(categories, 'bar'), /<img|<script/);
});

test('independent chart preferences persist only whitelisted display settings', () => {
  const storage = memoryStorage();
  assert.deepEqual(readChartTypes(storage), { movement: 'bar', categories: 'bar' });
  saveChartTypes(storage, { movement: 'pie', categories: 'bar', balance: 123456, privateNote: 'financial data' });
  assert.deepEqual(readChartTypes(storage), { movement: 'pie', categories: 'bar' });
  saveChartTypes(storage, { movement: 'pie', categories: 'pie' });
  assert.deepEqual(readChartTypes(storage), { movement: 'pie', categories: 'pie' });
  saveChartTypes(storage, { movement: 'bar', categories: 'pie' });
  assert.deepEqual(readChartTypes(storage), { movement: 'bar', categories: 'pie' });
  assert.equal(storage.records.size, 1);
  assert.deepEqual(Object.keys(JSON.parse(storage.getItem('spokoino-chart-types'))).sort(), ['categories', 'movement']);
  assert.doesNotMatch(storage.getItem('spokoino-chart-types'), /123456|financial data/);
});

test('corrupt, unsupported and denied storage safely falls back without throwing', () => {
  for (const text of ['broken JSON', 'null', '42', '"pie"', '{"movement":"line","categories":"pie","__proto__":{"movement":"pie"}}']) {
    const types = readChartTypes(memoryStorage({ 'spokoino-chart-types': text }));
    assert.equal(types.movement, 'bar');
    assert.equal(types.categories, text.includes('"categories":"pie"') ? 'pie' : 'bar');
  }
  const denied = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } };
  assert.deepEqual(readChartTypes(denied), { movement: 'bar', categories: 'bar' });
  assert.doesNotThrow(() => saveChartTypes(denied, { movement: 'pie', categories: 'pie' }));
  const storage = memoryStorage();
  saveChartTypes(storage, { movement: 'invalid', categories: 'invalid' });
  assert.deepEqual(readChartTypes(storage), { movement: 'bar', categories: 'bar' });
});
