import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getDatabase } from '../src/db/database.js';
import { InvoicesRepository } from '../src/db/invoices.repo.js';
import { InvoiceWorkflow } from '../src/workflow/invoice-workflow.js';
import { GeminiInvoiceRecognizer } from '../src/gemini/recognizer.js';
import { parseInvoiceEditText } from '../src/bot/parser.js';
import { InvoiceData } from '../src/types/index.js';

const TEST_HYBRID_DB = './data/test_hybrid.db';

function createTestRepo(): InvoicesRepository {
  if (fs.existsSync(TEST_HYBRID_DB)) {
    try { fs.unlinkSync(TEST_HYBRID_DB); } catch {}
  }
  const db = getDatabase(TEST_HYBRID_DB);
  return new InvoicesRepository(db);
}

test('parseInvoiceEditText supports item warehouse switching', () => {
  const initial: InvoiceData = {
    date: '15.11.2026',
    supplier: 'Мясоторг',
    warehouse: 'kitchen',
    items: [
      { name: 'Говядина', qty: 10, price: 600, sum: 6000, warehouse: 'kitchen' },
      { name: 'Универсальное средство', qty: 2, price: 200, sum: 400, warehouse: 'kitchen' }
    ]
  };

  const res = parseInvoiceEditText('2: склад хоз', initial);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.data?.items[1].warehouse, 'household');
  assert.match(res.message, /переведена на Хоз склад/);

  // Switch back
  const resBack = parseInvoiceEditText('2 склад кухня', res.data!);
  assert.strictEqual(resBack.success, true);
  assert.strictEqual(resBack.data?.items[1].warehouse, 'kitchen');

  // Variations: "1 - хоз", "#1: хоз", out-of-range index
  const resDash = parseInvoiceEditText('1 - хоз', initial);
  assert.strictEqual(resDash.success, true);
  assert.strictEqual(resDash.data?.items[0].warehouse, 'household');

  const resHash = parseInvoiceEditText('#1: хоз', initial);
  assert.strictEqual(resHash.success, true);
  assert.strictEqual(resHash.data?.items[0].warehouse, 'household');

  const resOutOfRange = parseInvoiceEditText('99: склад хоз', initial);
  assert.strictEqual(resOutOfRange.success, false);
  assert.match(resOutOfRange.message, /не найдена/);

  // Global warehouse command: "склад: хоз" switches all items
  const resGlobalWh = parseInvoiceEditText('склад: хоз', initial);
  assert.strictEqual(resGlobalWh.success, true);
  assert.strictEqual(resGlobalWh.data?.warehouse, 'household');
  assert.strictEqual(resGlobalWh.data?.items[0].warehouse, 'household', 'All items should move to household when whole invoice warehouse changes');
  assert.strictEqual(resGlobalWh.data?.items[1].warehouse, 'household');
});


test('parseInvoiceEditText auto-classifies added items by roots and tags', () => {
  const initial: InvoiceData = {
    date: '15.11.2026',
    supplier: 'ОптСнаб',
    warehouse: 'kitchen',
    items: [{ name: 'Сыр', qty: 2, price: 300, sum: 600, warehouse: 'kitchen' }]
  };

  // Adding item with household root -> auto-classified as household
  const res1 = parseInvoiceEditText('+ Перчатки нитрил 3уп * 200', initial);
  assert.strictEqual(res1.success, true);
  assert.strictEqual(res1.data?.items[1].warehouse, 'household');

  // Adding item with explicit tag [хоз]
  const res2 = parseInvoiceEditText('+ Расходники [хоз] 1 * 500', initial);
  assert.strictEqual(res2.success, true);
  assert.strictEqual(res2.data?.items[1].warehouse, 'household');
  assert.strictEqual(res2.data?.items[1].name, 'Расходники');

  // Single-line edit with tag: "1: Перчатки [хоз] 2 * 150"
  const res3 = parseInvoiceEditText('1: Перчатки [хоз] 2 * 150', initial);
  assert.strictEqual(res3.success, true);
  assert.strictEqual(res3.data?.items[0].name, 'Перчатки');
  assert.strictEqual(res3.data?.items[0].warehouse, 'household');

  // Multi-line paste with tags:
  const multiline = `Поставщик: ОптСнаб
Дата: 15.11.2026
Склад: Кухня
1. Сыр [кухня]: 2 кг * 300
2. Тряпка [хоз]: 3 шт * 100`;
  const resMulti = parseInvoiceEditText(multiline, initial);
  assert.strictEqual(resMulti.success, true);
  assert.strictEqual(resMulti.data?.items.length, 2);
  assert.strictEqual(resMulti.data?.items[0].name, 'Сыр');
  assert.strictEqual(resMulti.data?.items[0].warehouse, 'kitchen');
  assert.strictEqual(resMulti.data?.items[1].name, 'Тряпка');
  assert.strictEqual(resMulti.data?.items[1].warehouse, 'household');
});


test('InvoiceWorkflow supports snapshot and undo rollbacks', () => {
  const repo = createTestRepo();
  const workflow = new InvoiceWorkflow({ repo });

  const initial: InvoiceData = {
    date: '15.11.2026',
    supplier: 'Поставщик 1',
    warehouse: 'kitchen',
    items: [
      { name: 'Товар А', qty: 10, price: 100, sum: 1000, warehouse: 'kitchen' },
      { name: 'Товар Б', qty: 5, price: 50, sum: 250, warehouse: 'kitchen' }
    ]
  };

  const { invoiceId } = repo.saveInvoice(initial);
  assert.strictEqual(workflow.canUndo(invoiceId), false);

  // Apply first edit
  workflow.applyTextEdit(invoiceId, '1: 20 * 100');
  assert.strictEqual(workflow.canUndo(invoiceId), true);
  let current = repo.getInvoice(invoiceId);
  assert.strictEqual(current?.data.items[0].qty, 20);

  // Apply second edit (delete item 2)
  workflow.deleteItem(invoiceId, 1);
  current = repo.getInvoice(invoiceId);
  assert.strictEqual(current?.data.items.length, 1);

  // Undo second edit -> item 2 is restored!
  const undo1 = workflow.undoEdit(invoiceId);
  assert.strictEqual(undo1.success, true);
  current = repo.getInvoice(invoiceId);
  assert.strictEqual(current?.data.items.length, 2);
  assert.strictEqual(current?.data.items[0].qty, 20);

  // Undo first edit -> initial quantity (10) restored!
  const undo2 = workflow.undoEdit(invoiceId);
  assert.strictEqual(undo2.success, true);
  current = repo.getInvoice(invoiceId);
  assert.strictEqual(current?.data.items[0].qty, 10);

  // No more undos
  assert.strictEqual(workflow.canUndo(invoiceId), false);
  const undo3 = workflow.undoEdit(invoiceId);
  assert.strictEqual(undo3.success, false);
});

test('InvoiceWorkflow applyHybridEdit runs regex first, and calls Gemini for free text', async () => {
  const repo = createTestRepo();
  let aiCalled = false;
  let aiPrompt = '';

  const mockRecognizer = {
    recognizeEdit: async (currentData: InvoiceData, userPrompt: string) => {
      aiCalled = true;
      aiPrompt = userPrompt;
      return {
        data: {
          ...currentData,
          supplier: 'ИП Ахмедов',
          items: [
            { name: 'Помидоры', qty: 5, price: 180, sum: 900, warehouse: 'kitchen' as const }
          ]
        },
        summary: 'Изменен поставщик на ИП Ахмедов и цена помидоров на 180 ₽'
      };
    }
  } as unknown as GeminiInvoiceRecognizer;

  const workflow = new InvoiceWorkflow({
    repo,
    recognizer: mockRecognizer
  });

  const { invoiceId } = repo.saveInvoice({
    date: '15.11.2026',
    supplier: 'Старый поставщик',
    warehouse: 'kitchen',
    items: [{ name: 'Помидоры', qty: 5, price: 200, sum: 1000, warehouse: 'kitchen' }]
  });

  // 1. Fast regex command -> does NOT invoke AI
  const resRegex = await workflow.applyHybridEdit(invoiceId, '1: 5 * 190');
  assert.strictEqual(resRegex.success, true);
  assert.strictEqual(aiCalled, false, 'Fast regex must not invoke Gemini');
  let current = repo.getInvoice(invoiceId);
  assert.strictEqual(current?.data.items[0].price, 190);

  // 2. Free natural language input -> invokes Gemini!
  const resAi = await workflow.applyHybridEdit(invoiceId, 'Помидоры не по 200, а по 180, а поставщик ИП Ахмедов');
  assert.strictEqual(resAi.success, true);
  assert.strictEqual(aiCalled, true, 'Natural language must invoke Gemini');
  assert.match(aiPrompt, /Помидоры не по 200, а по 180/);
  assert.match(resAi.message, /ИП Ахмедов/);

  current = repo.getInvoice(invoiceId);
  assert.strictEqual(current?.data.supplier, 'ИП Ахмедов');
  assert.strictEqual(current?.data.items[0].price, 180);
});
