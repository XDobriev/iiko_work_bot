import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getDatabase } from '../src/db/database.js';
import { InvoicesRepository } from '../src/db/invoices.repo.js';
import { InvoiceData, HistoricalComparison } from '../src/types/index.js';
import { formatInvoiceMessage } from '../src/bot/formatter.js';
import { formatModelsOverview } from '../src/bot/bot.js';

const TEST_DB = './data/test_models_tracking.db';

test('InvoicesRepository tracks model_used and aggregates statistics', () => {
  if (fs.existsSync(TEST_DB)) {
    try { fs.unlinkSync(TEST_DB); } catch {}
  }

  const db = getDatabase(TEST_DB);
  const repo = new InvoicesRepository(db);

  const invoice1: InvoiceData = {
    date: '15.11.2026',
    supplier: 'Мясной Двор',
    warehouse: 'kitchen',
    items: [{ name: 'Говядина', qty: 10, price: 600, sum: 6000, unit: 'кг' }],
    total_written: 6000,
    model_used: 'gemini-3.5-flash-lite'
  };

  const { invoiceId: id1 } = repo.saveInvoice(invoice1);
  const saved1 = repo.getInvoice(id1);
  assert.ok(saved1);
  assert.strictEqual(saved1.invoice.model_used, 'gemini-3.5-flash-lite');
  assert.strictEqual(saved1.data.model_used, 'gemini-3.5-flash-lite');

  // Second invoice with meta.modelUsed and escalation
  const invoice2: InvoiceData = {
    date: '15.11.2026',
    supplier: 'Овощная База',
    warehouse: 'kitchen',
    items: [{ name: 'Томаты', qty: 5, price: 200, sum: 1000, unit: 'кг' }],
    total_written: 1000
  };

  const { invoiceId: id2 } = repo.saveInvoice(invoice2, {
    modelUsed: 'gemini-3.5-flash (эскалация)'
  });
  const saved2 = repo.getInvoice(id2);
  assert.ok(saved2);
  assert.strictEqual(saved2.invoice.model_used, 'gemini-3.5-flash (эскалация)');
  assert.strictEqual(saved2.data.model_used, 'gemini-3.5-flash (эскалация)');

  // Third invoice with same model as #1
  const invoice3: InvoiceData = {
    date: '15.11.2026',
    supplier: 'ХозСнаб',
    warehouse: 'household',
    items: [{ name: 'Перчатки', qty: 2, price: 150, sum: 300, unit: 'уп' }],
    model_used: 'gemini-3.5-flash-lite'
  };
  repo.saveInvoice(invoice3);

  // Model statistics
  const stats = repo.getModelStats();
  assert.strictEqual(stats.length, 2);

  const flashLiteStat = stats.find(s => s.model === 'gemini-3.5-flash-lite');
  assert.ok(flashLiteStat);
  assert.strictEqual(flashLiteStat.count, 2);

  const escStat = stats.find(s => s.model.includes('эскалация'));
  assert.ok(escStat);
  assert.strictEqual(escStat.count, 1);

  // Test updating model on existing invoice
  repo.updateInvoiceModel(id1, 'gemini-3.8-flash');
  const updated1 = repo.getInvoice(id1);
  assert.strictEqual(updated1?.invoice.model_used, 'gemini-3.8-flash');
});

test('formatInvoiceMessage displays model badge and escalation indicator', () => {
  const comparison: HistoricalComparison = {
    isDuplicate: false,
    priceComparisons: [],
    totalPriceDelta: 0,
    mathDiscrepancy: false,
    discrepancyDiff: 0
  };

  // Normal recognition
  const normalInvoice: InvoiceData = {
    date: '15.11.2026',
    supplier: 'Поставщик',
    warehouse: 'kitchen',
    items: [{ name: 'Сыр', qty: 1, price: 500, sum: 500, unit: 'кг' }],
    total_written: 500,
    model_used: 'gemini-3.5-flash-lite'
  };

  const normalMsg = formatInvoiceMessage(1, normalInvoice, comparison);
  assert.match(normalMsg, /🤖 <i>Модель: gemini-3\.5-flash-lite<\/i>/);

  // Escalated recognition
  const escalatedInvoice: InvoiceData = {
    ...normalInvoice,
    model_used: 'gemini-3.5-flash (эскалация)'
  };
  const escalatedMsg = formatInvoiceMessage(2, escalatedInvoice, comparison);
  assert.match(escalatedMsg, /⚡️ <i>Модель: gemini-3\.5-flash \(эскалация\)<\/i>/);

  // Special characters are escaped
  const xssInvoice: InvoiceData = {
    ...normalInvoice,
    model_used: 'gemini-<danger>&test'
  };
  const xssMsg = formatInvoiceMessage(3, xssInvoice, comparison);
  assert.ok(!xssMsg.includes('gemini-<danger>'));
  assert.ok(xssMsg.includes('gemini-&lt;danger&gt;&amp;test'));
});

test('formatModelsOverview formats active models and database stats', () => {
  const stats = [
    { model: 'gemini-3.5-flash-lite', count: 12, lastUsed: '2026-11-15 14:00:00' },
    { model: 'gemini-3.5-flash (эскалация)', count: 3, lastUsed: '2026-11-15 15:30:00' }
  ];

  const overview = formatModelsOverview(stats);
  assert.match(overview, /Настройка моделей Gemini ресторана «Бейни»/);
  assert.match(overview, /Фото накладных/);
  assert.match(overview, /Голосовые заказы/);
  assert.match(overview, /Сложные чеки/);
  assert.match(overview, /gemini-3\.5-flash-lite.*12.*накладных/);
  assert.match(overview, /gemini-3\.5-flash \(эскалация\).*3.*накладных/);
});
