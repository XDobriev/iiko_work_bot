import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, formatInvoiceMessage, formatDailyStats } from '../src/bot/formatter.js';
import { InvoiceData, HistoricalComparison } from '../types/index.js';

test('escapeHtml properly escapes HTML special characters', () => {
  assert.strictEqual(escapeHtml('Tom & Jerry <script>alert("xss")</script> > 5'), 'Tom &amp; Jerry &lt;script&gt;alert("xss")&lt;/script&gt; &gt; 5');
  assert.strictEqual(escapeHtml('Обычный текст без спецсимволов'), 'Обычный текст без спецсимволов');
  assert.strictEqual(escapeHtml('a & b & c < d > e'), 'a &amp; b &amp; c &lt; d &gt; e');
});

test('formatInvoiceMessage formats header, table, and duplicate alert', () => {
  const data: InvoiceData = {
    date: '15.11.2026',
    supplier: 'Бойня «Север» & Ко',
    warehouse: 'kitchen',
    items: [
      { name: 'Говядина мякоть', qty: 10, price: 600, sum: 6000, unit: 'кг' },
      { name: 'Лук репчатый', qty: 20, price: 30, sum: 600, unit: 'кг' }
    ],
    total_written: 6600
  };

  const comparison: HistoricalComparison = {
    isDuplicate: true,
    duplicateInvoiceId: 42,
    duplicateDate: '15.11.2026',
    priceComparisons: [
      {
        name: 'Говядина мякоть',
        currentPrice: 600,
        currentQty: 10,
        currentSum: 6000,
        currentUnit: 'кг',
        previousPrice: 550,
        previousDate: '01.11.2026',
        previousUnit: 'кг',
        deltaRub: 50,
        deltaPercent: 9.1,
        trend: 'up'
      }
    ],
    totalPriceDelta: 500,
    mathDiscrepancy: false,
    discrepancyDiff: 0
  };

  const msg = formatInvoiceMessage(101, data, comparison);

  // Escaping in header
  assert.match(msg, /Бойня «Север» &amp; Ко/);
  assert.match(msg, /Накладная #101/);
  assert.match(msg, /Склад Кухня/);

  // Duplicate warning
  assert.match(msg, /ВНИМАНИЕ: Возможный дубликат!/);
  assert.match(msg, /ранее ID #42/);

  // Table
  assert.match(msg, /<pre>#  Наименование/);
  assert.match(msg, /ИТОГО:\s*6600/);

  // Price comparison
  assert.match(msg, /Сверка с предыдущими ценами:/);
  assert.match(msg, /🔺 <b>Говядина мякоть<\/b>: <b>600 ₽\/кг<\/b> \(\+50 ₽ \/ \+9\.1% к 01\.11\.2026\)/);
});

test('formatInvoiceMessage uses expandable blockquote for large invoices and detects math discrepancy', () => {
  const data: InvoiceData = {
    date: '16.11.2026',
    supplier: 'ХозСнаб',
    warehouse: 'household',
    items: [
      { name: 'Перчатки латекс', qty: 5, price: 100, sum: 500, unit: 'уп' },
      { name: 'Салфетки бумажные', qty: 10, price: 50, sum: 500, unit: 'уп' },
      { name: 'Губки кухонные', qty: 4, price: 60, sum: 240, unit: 'уп' },
      { name: 'Моющее средство', qty: 2, price: 300, sum: 600, unit: 'бут' }
    ],
    total_written: 1500 // Discrepancy: actual sum is 1840
  };

  const comparison: HistoricalComparison = {
    isDuplicate: false,
    priceComparisons: [],
    totalPriceDelta: 0,
    mathDiscrepancy: true,
    discrepancyDiff: 340
  };

  const msg = formatInvoiceMessage(102, data, comparison);
  assert.match(msg, /Хоз склад/);
  assert.match(msg, /<blockquote expandable><pre>/);
  assert.match(msg, /⚠️ <b>Расхождение в сумме!<\/b>/);
  assert.match(msg, /разница: 340 ₽/);
});

test('formatDailyStats handles empty and filled reports', () => {
  const empty = formatDailyStats({
    date: '14.11.2026',
    totalInvoices: 0,
    totalSpend: 0,
    kitchenSpend: 0,
    householdSpend: 0,
    supplierCount: 0,
    suppliers: []
  });
  assert.match(empty, /За сегодня накладных ещё не поступало/);

  const filled = formatDailyStats({
    date: '14.11.2026',
    totalInvoices: 3,
    totalSpend: 25000,
    kitchenSpend: 20000,
    householdSpend: 5000,
    supplierCount: 2,
    suppliers: [
      { supplier: 'Бойня', count: 2, total: 18000 },
      { supplier: 'Овощи & Фрукты', count: 1, total: 7000 }
    ]
  });
  assert.match(filled, /Всего накладных: <b>3<\/b>/);
  assert.match(filled, /Овощи &amp; Фрукты/);

  // With 3+ suppliers, wraps in <blockquote expandable>
  const withManySuppliers = formatDailyStats({
    date: '14.11.2026',
    totalInvoices: 4,
    totalSpend: 35000,
    kitchenSpend: 28000,
    householdSpend: 7000,
    supplierCount: 3,
    suppliers: [
      { supplier: 'Бойня', count: 2, total: 18000 },
      { supplier: 'Овощи', count: 1, total: 7000 },
      { supplier: 'Молочный комбинат', count: 1, total: 10000 }
    ]
  });
  assert.match(withManySuppliers, /<blockquote expandable>/);
  assert.match(withManySuppliers, /Молочный комбинат/);
});

test('formatInvoiceMessage wraps multiple price comparisons in expandable blockquote', () => {
  const data: InvoiceData = {
    date: '16.11.2026',
    supplier: 'Овощной рай',
    warehouse: 'kitchen',
    items: [
      { name: 'Помидоры', qty: 10, price: 250, sum: 2500, unit: 'кг' },
      { name: 'Огурцы', qty: 8, price: 180, sum: 1440, unit: 'кг' }
    ],
    total_written: null
  };

  const comp: HistoricalComparison = {
    isDuplicate: false,
    priceComparisons: [
      {
        name: 'Помидоры',
        currentPrice: 250,
        currentQty: 10,
        currentSum: 2500,
        previousPrice: 200,
        previousDate: '10.11.2026',
        deltaRub: 50,
        deltaPercent: 25,
        trend: 'up'
      },
      {
        name: 'Огурцы',
        currentPrice: 180,
        currentQty: 8,
        currentSum: 1440,
        previousPrice: 150,
        previousDate: '10.11.2026',
        deltaRub: 30,
        deltaPercent: 20,
        trend: 'up'
      }
    ],
    totalPriceDelta: 80,
    mathDiscrepancy: false,
    discrepancyDiff: 0
  };

  const msg = formatInvoiceMessage(105, data, comp);
  assert.match(msg, /<blockquote expandable>/);
  assert.match(msg, /🔺 <b>Помидоры<\/b>/);
  assert.match(msg, /🔺 <b>Огурцы<\/b>/);
});
