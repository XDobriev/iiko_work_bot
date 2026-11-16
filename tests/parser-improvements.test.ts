import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getDatabase } from '../src/db/database.js';
import { InvoicesRepository } from '../src/db/invoices.repo.js';
import { InvoiceWorkflow } from '../src/workflow/invoice-workflow.js';
import { InvoiceData } from '../src/types/index.js';
import { parseInvoiceEditText } from '../src/bot/parser.js';

const TEST_DB = './data/test_parser_improvements.db';

function setupRepo(): InvoicesRepository {
  if (fs.existsSync(TEST_DB)) {
    try { fs.unlinkSync(TEST_DB); } catch {}
  }
  const db = getDatabase(TEST_DB);
  return new InvoicesRepository(db);
}

test('parseInvoiceEditText returns isDeterministicError for out-of-range index and invalid commands', () => {
  const initial: InvoiceData = {
    date: '16.11.2026',
    supplier: 'Овощная База',
    warehouse: 'kitchen',
    items: [
      { name: 'Картофель', qty: 20, price: 35, sum: 700, unit: 'кг' },
      { name: 'Лук', qty: 10, price: 30, sum: 300, unit: 'кг' }
    ],
    total_written: 1000
  };

  // 1. Delete out of range
  const delErr = parseInvoiceEditText('удалить 99', initial);
  assert.strictEqual(delErr.success, false);
  assert.strictEqual(delErr.isDeterministicError, true);
  assert.match(delErr.message, /Строка #99 не найдена/);

  // 2. Edit out of range
  const editOutOfRange = parseInvoiceEditText('5: 10 * 50', initial);
  assert.strictEqual(editOutOfRange.success, false);
  assert.strictEqual(editOutOfRange.isDeterministicError, true);
  assert.match(editOutOfRange.message, /Строка #5 не найдена/);

  // 3. Item warehouse out of range
  const whOutOfRange = parseInvoiceEditText('10 склад хоз', initial);
  assert.strictEqual(whOutOfRange.success, false);
  assert.strictEqual(whOutOfRange.isDeterministicError, true);
  assert.match(whOutOfRange.message, /Строка #10 не найдена/);

  // 4. Incomplete add command
  const addIncomplete = parseInvoiceEditText('+ Томаты черри', initial);
  assert.strictEqual(addIncomplete.success, false);
  assert.strictEqual(addIncomplete.isDeterministicError, true);
  assert.match(addIncomplete.message, /укажите количество и цену/);

  // 5. Incomplete edit line (missing price)
  const editIncomplete = parseInvoiceEditText('1: 15кг', initial);
  assert.strictEqual(editIncomplete.success, false);
  assert.strictEqual(editIncomplete.isDeterministicError, true);
  assert.match(editIncomplete.message, /укажите количество и цену/);

  // 6. Invalid warehouse name
  const invalidWh = parseInvoiceEditText('склад: балкон', initial);
  assert.strictEqual(invalidWh.success, false);
  assert.strictEqual(invalidWh.isDeterministicError, true);
  assert.match(invalidWh.message, /Неизвестный склад/);
});

test('applyHybridEdit skips Gemini API call on deterministic errors', async () => {
  const repo = setupRepo();

  let aiCalls = 0;
  const mockRecognizer: any = {
    recognizeEdit: async () => {
      aiCalls++;
      throw new Error('Gemini API should NOT be invoked for deterministic errors!');
    }
  };

  const workflow = new InvoiceWorkflow({ repo, recognizer: mockRecognizer });

  const initial: InvoiceData = {
    date: '16.11.2026',
    supplier: 'Овощная База',
    warehouse: 'kitchen',
    items: [
      { name: 'Картофель', qty: 20, price: 35, sum: 700, unit: 'кг' }
    ],
    total_written: 700
  };

  const { invoiceId } = repo.saveInvoice(initial);

  // 1. Attempt out of range delete -> should fail fast without Gemini
  const delRes = await workflow.applyHybridEdit(invoiceId, 'удалить 10');
  assert.strictEqual(delRes.success, false);
  assert.match(delRes.message, /Строка #10 не найдена/);
  assert.strictEqual(aiCalls, 0, 'Gemini must not be called');

  // 2. Attempt incomplete add -> should fail fast without Gemini
  const addRes = await workflow.applyHybridEdit(invoiceId, '+ Морковь');
  assert.strictEqual(addRes.success, false);
  assert.match(addRes.message, /укажите количество и цену/);
  assert.strictEqual(aiCalls, 0, 'Gemini must not be called');

  // 3. Attempt incomplete edit -> should fail fast without Gemini
  const editRes = await workflow.applyHybridEdit(invoiceId, '1: 50');
  assert.strictEqual(editRes.success, false);
  assert.match(editRes.message, /укажите количество и цену/);
  assert.strictEqual(aiCalls, 0, 'Gemini must not be called');
});

test('applyHybridEdit falls back to Gemini for natural language queries', async () => {
  const repo = setupRepo();

  let aiCalls = 0;
  const mockRecognizer: any = {
    recognizeEdit: async (data: InvoiceData, prompt: string) => {
      aiCalls++;
      return {
        data: {
          ...data,
          items: [{ ...data.items[0], price: 30, sum: 600 }]
        },
        summary: 'Картофель изменен на 30 ₽'
      };
    }
  };

  const workflow = new InvoiceWorkflow({ repo, recognizer: mockRecognizer });

  const initial: InvoiceData = {
    date: '16.11.2026',
    supplier: 'Овощная База',
    warehouse: 'kitchen',
    items: [
      { name: 'Картофель', qty: 20, price: 35, sum: 700, unit: 'кг' }
    ],
    total_written: 700
  };

  const { invoiceId } = repo.saveInvoice(initial);

  const res = await workflow.applyHybridEdit(invoiceId, 'картофель не по 35 а по 30 рублей');
  assert.strictEqual(res.success, true);
  assert.strictEqual(aiCalls, 1, 'Gemini should be called for natural text');
  assert.match(res.message, /Картофель изменен на 30 ₽/);
  assert.strictEqual(res.data?.items[0].price, 30);
});
