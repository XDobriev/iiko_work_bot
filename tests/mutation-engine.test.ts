import test from 'node:test';
import assert from 'node:assert/strict';
import { getDatabase } from '../src/db/database.js';
import { InvoicesRepository } from '../src/db/invoices.repo.js';
import { InvoiceMutationEngine } from '../src/workflow/mutation-engine.js';
import { HeadlessPresentationAdapter } from '../src/presentation/telegram-adapter.js';
import { InvoiceData } from '../src/types/index.js';
import { GeminiInvoiceRecognizer } from '../gemini/recognizer.js';

function setupEngine(inFlight = false) {
  const db = getDatabase(':memory:');
  const repo = new InvoicesRepository(db);
  const presenter = new HeadlessPresentationAdapter();
  const mockRecognizer = {} as GeminiInvoiceRecognizer;

  const engine = new InvoiceMutationEngine({
    repo,
    recognizer: mockRecognizer,
    presenter,
    photosDir: './data/photos',
    isSyncInProgress: () => inFlight
  });

  return { db, repo, engine, presenter };
}

test('InvoiceMutationEngine.sanitizeAndRecalculate recalculates line sums and total', () => {
  const { engine } = setupEngine();

  const rawData: InvoiceData = {
    date: '16.11.2026',
    supplier: 'Тест',
    warehouse: 'kitchen',
    items: [
      { name: 'Картофель', qty: 2.5, price: 40, sum: 0, warehouse: 'kitchen' },
      { name: 'Лук', qty: 10, price: 25, sum: 999, warehouse: 'kitchen' }
    ],
    total_written: null
  };

  const sanitized = engine.sanitizeAndRecalculate(rawData);
  const total = engine.calculateTotal(sanitized);

  // 2.5 * 40 = 100, 10 * 25 = 250 -> total 350
  assert.equal(sanitized.items[0].sum, 100);
  assert.equal(sanitized.items[1].sum, 250);
  assert.equal(total, 350);
});

test('InvoiceMutationEngine blocks mutations when sync is in progress', () => {
  const { repo, engine } = setupEngine(true);

  const rawData: InvoiceData = {
    date: '16.11.2026',
    supplier: 'Тест',
    warehouse: 'kitchen',
    items: [{ name: 'Морковь', qty: 1, price: 30, sum: 30 }],
    total_written: null
  };
  const { invoiceId } = repo.saveInvoice(rawData);

  const resData = engine.applyData(invoiceId, rawData);
  assert.equal(resData.success, false);
  assert.match(resData.message, /отправляется в iiko/i);

  const resText = engine.applyText(invoiceId, '1 5 30');
  assert.equal(resText.success, false);
  assert.match(resText.message, /отправляется в iiko/i);

  const resDelete = engine.deleteItem(invoiceId, 0);
  assert.equal(resDelete.success, false);
  assert.match(resDelete.error || '', /отправляется в iiko/i);

  const resToggle = engine.toggleWarehouse(invoiceId);
  assert.equal(resToggle.success, false);
  assert.match(resToggle.error || '', /отправляется в iiko/i);

  const resUndo = engine.undo(invoiceId);
  assert.equal(resUndo.success, false);
  assert.match(resUndo.message, /отправляется в iiko/i);
});

test('InvoiceMutationEngine pushes snapshots and supports undo', () => {
  const { repo, engine } = setupEngine(false);

  const initialData: InvoiceData = {
    date: '16.11.2026',
    supplier: 'База',
    warehouse: 'kitchen',
    items: [
      { name: 'Огурцы', qty: 5, price: 100, sum: 500, warehouse: 'kitchen' }
    ],
    total_written: null
  };
  const { invoiceId } = repo.saveInvoice(initialData);

  // Mutation 1: change quantity via text command
  const res1 = engine.applyText(invoiceId, '1 10 100');
  assert.equal(res1.success, true);
  assert.equal(res1.data?.items[0].qty, 10);
  assert.equal(res1.data?.items[0].sum, 1000);

  // Mutation 2: delete item
  const resDel = engine.deleteItem(invoiceId, 0);
  assert.equal(resDel.success, true);
  assert.equal(resDel.data?.items.length, 0);

  // Undo mutation 2 (restores 10 items)
  const undo1 = engine.undo(invoiceId);
  assert.equal(undo1.success, true);
  assert.equal(undo1.data?.items.length, 1);
  assert.equal(undo1.data?.items[0].qty, 10);

  // Undo mutation 1 (restores original 5 items)
  const undo2 = engine.undo(invoiceId);
  assert.equal(undo2.success, true);
  assert.equal(undo2.data?.items[0].qty, 5);

  // Undo 3: stack empty
  const undo3 = engine.undo(invoiceId);
  assert.equal(undo3.success, false);
  assert.match(undo3.message, /нет предыдущих/i);
});

test('InvoiceMutationEngine.deleteItem rejects invalid index and handles out-of-bounds', () => {
  const { repo, engine } = setupEngine(false);

  const initialData: InvoiceData = {
    date: '16.11.2026',
    supplier: 'База',
    warehouse: 'kitchen',
    items: [{ name: 'Огурцы', qty: 5, price: 100, sum: 500 }],
    total_written: null
  };
  const { invoiceId } = repo.saveInvoice(initialData);

  const resNegative = engine.deleteItem(invoiceId, -1);
  assert.equal(resNegative.success, false);
  assert.match(resNegative.error || '', /некорректный индекс/i);

  const resOverflow = engine.deleteItem(invoiceId, 99);
  assert.equal(resOverflow.success, false);
  assert.match(resOverflow.error || '', /некорректный индекс/i);
});

test('InvoiceMutationEngine.toggleWarehouse switches warehouse and supports undo', () => {
  const { repo, engine } = setupEngine(false);

  const initialData: InvoiceData = {
    date: '16.11.2026',
    supplier: 'База',
    warehouse: 'kitchen',
    items: [{ name: 'Мука', qty: 10, price: 50, sum: 500, warehouse: 'kitchen' }]
  };
  const { invoiceId } = repo.saveInvoice(initialData);

  const toggleRes = engine.toggleWarehouse(invoiceId);
  assert.equal(toggleRes.success, true);
  assert.equal(toggleRes.newWarehouse, 'household');
  assert.equal(toggleRes.data?.warehouse, 'household');

  // Undo toggle
  const undoRes = engine.undo(invoiceId);
  assert.equal(undoRes.success, true);
  assert.equal(undoRes.data?.warehouse, 'kitchen');
});

test('InvoiceMutationEngine.sanitizeAndRecalculate handles negative values and keyword roots', () => {
  const { engine } = setupEngine(false);

  const data: InvoiceData = {
    date: '16.11.2026',
    supplier: 'Тест',
    warehouse: 'kitchen',
    items: [
      { name: 'Перчатки латексные', qty: -5, price: -100, sum: 0 },
      { name: 'Помидоры', qty: NaN as any, price: 50, sum: 0 }
    ]
  };

  const sanitized = engine.sanitizeAndRecalculate(data);
  // Negative values clamped to 0
  assert.equal(sanitized.items[0].qty, 0);
  assert.equal(sanitized.items[0].price, 0);
  assert.equal(sanitized.items[0].sum, 0);
  // Перчатки auto-classified to household by Russian roots
  assert.equal(sanitized.items[0].warehouse, 'household');
  // NaN clamped to 0
  assert.equal(sanitized.items[1].qty, 0);
  assert.equal(sanitized.items[1].warehouse, 'kitchen');
});

test('InvoiceMutationEngine.applyVoice rejects no-op voice edits without pushing snapshots', async () => {
  const { repo, presenter } = setupEngine(false);

  const initialData: InvoiceData = {
    date: '16.11.2026',
    supplier: 'База',
    warehouse: 'kitchen',
    items: [{ name: 'Картофель', qty: 10, price: 30, sum: 300 }]
  };
  const { invoiceId } = repo.saveInvoice(initialData);

  const mockRecognizer = {
    recognizeVoiceEdit: async () => ({
      data: JSON.parse(JSON.stringify(initialData)), // identical data, no changes
      summary: 'Ничего не изменилось'
    })
  } as unknown as GeminiInvoiceRecognizer;

  const engine = new InvoiceMutationEngine({
    repo,
    recognizer: mockRecognizer,
    presenter,
    photosDir: './data/photos',
    isSyncInProgress: () => false
  });

  const res = await engine.applyVoice(invoiceId, Buffer.from('silence'), 'audio/ogg');
  assert.equal(res.success, false);
  assert.match(res.message, /не применились к накладной/i);
  // Must NOT push snapshot on no-op voice edit
  assert.equal(repo.hasSnapshot(invoiceId), false);
});
