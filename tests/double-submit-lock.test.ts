import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getDatabase } from '../src/db/database.js';
import { InvoicesRepository } from '../src/db/invoices.repo.js';
import { InvoiceWorkflow } from '../src/workflow/invoice-workflow.js';
import { InvoiceData } from '../src/types/index.js';
import { createBot } from '../src/bot/bot.js';
import { config } from '../src/config.js';

function setupTestEnvironment() {
  const db = getDatabase(':memory:');
  const repo = new InvoicesRepository(db);
  return { db, repo };
}

test('confirmAndSync blocks concurrent calls (double-submit mutex)', async () => {
  const { repo } = setupTestEnvironment();

  let createInvoiceCalls = 0;
  const mockIikoClient: any = {
    isConfigured: () => true,
    getProducts: async () => [
      { id: 'beef-1', name: 'Говядина шея', unit: 'кг' }
    ],
    createInvoice: async () => {
      createInvoiceCalls++;
      // Simulate real network delay (50ms)
      await new Promise(r => setTimeout(r, 50));
      return {
        success: true,
        documentNumber: 'IIKO-LOCK-001'
      };
    }
  };

  const workflow = new InvoiceWorkflow({ repo, iikoClient: mockIikoClient });

  const invoiceData: InvoiceData = {
    date: '16.11.2026',
    supplier: 'Ферма',
    warehouse: 'kitchen',
    items: [
      { name: 'Говядина шея', qty: 5, price: 600, sum: 3000, unit: 'кг', warehouse: 'kitchen' }
    ],
    total_written: 3000
  };

  const { invoiceId } = repo.saveInvoice(invoiceData);

  // Trigger two concurrent calls to confirmAndSync
  const call1Promise = workflow.confirmAndSync(invoiceId);
  assert.equal(workflow.isSyncInProgress(invoiceId), true, 'Sync should be flagged in progress');

  const call2Result = await workflow.confirmAndSync(invoiceId);

  // Call 2 must be blocked immediately
  assert.equal(call2Result.success, false, 'Second concurrent call must fail');
  assert.equal(call2Result.inProgress, true, 'Second call must report inProgress flag');
  assert.match(call2Result.message || '', /уже отправляется/i);

  // Wait for Call 1 to finish
  const call1Result = await call1Promise;
  assert.equal(call1Result.success, true, 'First call must succeed');
  assert.equal(call1Result.documentNumber, 'IIKO-LOCK-001');

  // Verify createInvoice was called strictly once
  assert.equal(createInvoiceCalls, 1, 'iikoClient.createInvoice must be called exactly once');

  // After completion, lock is cleared
  assert.equal(workflow.isSyncInProgress(invoiceId), false, 'Lock must be released after completion');
});

test('mutations are blocked while sync is in progress', async () => {
  const { repo } = setupTestEnvironment();

  let releaseSync: () => void = () => {};
  const mockIikoClient: any = {
    isConfigured: () => true,
    getProducts: async () => [
      { id: 'beef-1', name: 'Говядина шея', unit: 'кг' }
    ],
    createInvoice: async () => {
      await new Promise<void>(resolve => {
        releaseSync = resolve;
      });
      return { success: true, documentNumber: 'IIKO-LOCK-002' };
    }
  };

  const workflow = new InvoiceWorkflow({ repo, iikoClient: mockIikoClient });

  const invoiceData: InvoiceData = {
    date: '16.11.2026',
    supplier: 'Ферма',
    warehouse: 'kitchen',
    items: [
      { name: 'Говядина шея', qty: 5, price: 600, sum: 3000, unit: 'кг', warehouse: 'kitchen' }
    ],
    total_written: 3000
  };

  const { invoiceId } = repo.saveInvoice(invoiceData);

  // Start sync in background
  const syncPromise = workflow.confirmAndSync(invoiceId);

  // Test mutation methods during in-flight sync
  const toggleRes = workflow.toggleWarehouse(invoiceId);
  assert.equal(toggleRes.success, false);
  assert.match(toggleRes.error || '', /отправляется в iiko/i);

  const deleteRes = workflow.deleteItem(invoiceId, 0);
  assert.equal(deleteRes.success, false);
  assert.match(deleteRes.error || '', /отправляется в iiko/i);

  const editRes = workflow.applyDataEdit(invoiceId, invoiceData);
  assert.equal(editRes.success, false);
  assert.match(editRes.message || '', /отправляется в iiko/i);

  const hybridRes = await workflow.applyHybridEdit(invoiceId, '1 10 500');
  assert.equal(hybridRes.success, false);
  assert.match(hybridRes.message || '', /отправляется в iiko/i);

  const undoRes = workflow.undoEdit(invoiceId);
  assert.equal(undoRes.success, false);
  assert.match(undoRes.message || '', /отправляется в iiko/i);

  const rejectRes = workflow.rejectInvoice(invoiceId);
  assert.equal(rejectRes.success, false);
  assert.match(rejectRes.error || '', /отправляется в iiko/i);

  // Release sync
  releaseSync();
  const syncResult = await syncPromise;
  assert.equal(syncResult.success, true);
  assert.equal(workflow.isSyncInProgress(invoiceId), false);
});

test('bot callback dispatcher answers busy callback without errors', async () => {
  const { repo } = setupTestEnvironment();
  const workflow = new InvoiceWorkflow({ repo });
  const bot = createBot(workflow);

  bot.botInfo = {
    id: 100,
    is_bot: true,
    first_name: 'TestBot',
    username: 'test_bot',
    can_join_groups: true,
    can_read_all_group_messages: true,
    supports_inline_queries: false
  };

  const allowedId = config.telegram.allowedUserIds[0] || 123;
  let answeredText = '';
  bot.api.config.use(async (prev, method, payload) => {
    if (method === 'answerCallbackQuery') {
      answeredText = (payload as any).text;
      return { ok: true, result: true } as any;
    }
    return { ok: true, result: true } as any;
  });

  await bot.handleUpdate({
    update_id: 1,
    callback_query: {
      id: 'cb-1',
      from: { id: allowedId, is_bot: false, first_name: 'Tester' },
      message: {
        message_id: 50,
        date: 1700000000,
        chat: { id: -1001, type: 'group', title: 'Group' }
      },
      chat_instance: 'instance-1',
      data: 'busy:999'
    }
  });

  assert.match(answeredText, /отправляется в iikoWeb/i);
});

test('bot callback dispatcher debounces rapid duplicate callback clicks', async () => {
  const { repo } = setupTestEnvironment();
  let syncResolve: () => void = () => {};
  const mockIikoClient: any = {
    isConfigured: () => true,
    getProducts: async () => [{ id: 'beef-1', name: 'Говядина шея', unit: 'кг' }],
    createInvoice: async () => {
      await new Promise<void>(resolve => { syncResolve = resolve; });
      return { success: true, documentNumber: 'IIKO-LOCK-003' };
    }
  };

  const workflow = new InvoiceWorkflow({ repo, iikoClient: mockIikoClient });
  const invoiceData: InvoiceData = {
    date: '16.11.2026',
    supplier: 'Ферма',
    warehouse: 'kitchen',
    items: [{ name: 'Говядина шея', qty: 5, price: 600, sum: 3000, unit: 'кг', warehouse: 'kitchen' }],
    total_written: 3000
  };
  const { invoiceId } = repo.saveInvoice(invoiceData);
  const bot = createBot(workflow);
  bot.botInfo = {
    id: 100,
    is_bot: true,
    first_name: 'TestBot',
    username: 'test_bot',
    can_join_groups: true,
    can_read_all_group_messages: true,
    supports_inline_queries: false
  };

  const allowedId = config.telegram.allowedUserIds[0] || 123;
  const answeredTexts: string[] = [];
  bot.api.config.use(async (prev, method, payload) => {
    if (method === 'answerCallbackQuery') {
      answeredTexts.push((payload as any).text || '');
      return { ok: true, result: true } as any;
    }
    if (method === 'editMessageReplyMarkup' || method === 'editMessageText') {
      return { ok: true, result: true } as any;
    }
    return { ok: true, result: true } as any;
  });

  const cbUpdate = {
    update_id: 1,
    callback_query: {
      id: 'cb-1',
      from: { id: allowedId, is_bot: false, first_name: 'Tester' },
      message: {
        message_id: 50,
        date: 1700000000,
        chat: { id: -1001, type: 'group', title: 'Group' }
      },
      chat_instance: 'instance-1',
      data: `confirm:${invoiceId}`
    }
  };

  // Launch first click
  const p1 = bot.handleUpdate(cbUpdate as any);

  // Rapidly launch second click before first finishes
  const p2 = bot.handleUpdate({
    ...cbUpdate,
    update_id: 2,
    callback_query: { ...cbUpdate.callback_query, id: 'cb-2' }
  } as any);

  await p2;
  syncResolve();
  await p1;

  assert.ok(
    answeredTexts.some(t => /уже обрабатывается|уже отправляется/i.test(t)),
    'Second callback click must receive already processing notification'
  );
});
