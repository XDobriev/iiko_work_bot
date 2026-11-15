import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getDatabase } from '../src/db/database.js';
import { InvoicesRepository } from '../src/db/invoices.repo.js';
import { InvoiceWorkflow } from '../src/workflow/invoice-workflow.js';
import { IikoClient, IikoCreateInvoiceResult } from '../src/iiko/client.js';
import { createInvoiceKeyboard, updateTelegramInvoiceCard } from '../src/bot/bot.js';
import {
  partitionItemsByWarehouse,
  isHouseholdItemName,
  classifyItemWarehouse
} from '../src/workflow/warehouse-classifier.js';
import { startWebAppServer } from '../src/webapp/server.js';
import { InvoiceData } from '../src/types/index.js';

const TEST_REVIEW_DB = './data/test_review_fixes.db';

function setupRepo(): InvoicesRepository {
  if (fs.existsSync(TEST_REVIEW_DB)) {
    try { fs.unlinkSync(TEST_REVIEW_DB); } catch {}
  }
  const db = getDatabase(TEST_REVIEW_DB);
  return new InvoicesRepository(db);
}

// 1. [CRITICAL] Telegram API 400 Bad Request from empty keyboard row
test('createInvoiceKeyboard: no empty rows when url is empty and canUndo is false', () => {
  const kb = createInvoiceKeyboard(101, true, '', false);
  const rows = kb.inline_keyboard;

  // Verify no row is empty []
  for (let i = 0; i < rows.length; i++) {
    assert.ok(rows[i].length > 0, `Row ${i} must not be empty array []`);
  }

  // Row 1: confirm, reject (2 buttons)
  // Row 2: edit, toggle_wh, view_photo (3 buttons)
  // No row 3 because url is empty and canUndo is false
  assert.strictEqual(rows.length, 2, 'Should only have 2 rows when url is empty and canUndo=false');
});

test('createInvoiceKeyboard: adds row 3 when canUndo is true or url is present', () => {
  const kbWithUndo = createInvoiceKeyboard(102, true, '', true);
  assert.strictEqual(kbWithUndo.inline_keyboard.length, 3);
  const lastRow = kbWithUndo.inline_keyboard[2];
  assert.ok(lastRow.some(btn => btn.text.includes('Отменить')));

  const kbWithUrl = createInvoiceKeyboard(103, true, 'https://example.com', false);
  assert.strictEqual(kbWithUrl.inline_keyboard.length, 3);
  const rowWithEdit = kbWithUrl.inline_keyboard[2];
  assert.ok(rowWithEdit.some(btn => btn.text.includes('Наговорить')));
});

// 2. [CRITICAL] Cookie session race condition in split sync & partial failure handling
test('confirmAndSync: executes sequentially and records partial sync if household fails', async () => {
  const repo = setupRepo();

  const callOrder: string[] = [];
  const mockIiko = {
    isConfigured: () => true,
    createInvoice: async (data: InvoiceData): Promise<IikoCreateInvoiceResult> => {
      callOrder.push(data.warehouse || 'unknown');
      if (data.warehouse === 'household') {
        return {
          success: false,
          message: 'iiko 500: Server session error on household storage'
        };
      }
      return {
        success: true,
        documentNumber: 'DOC-KIT-777',
        documentId: 'guid-777'
      };
    }
  } as unknown as IikoClient;

  const workflow = new InvoiceWorkflow({ repo, iikoClient: mockIiko });

  const mixedInvoice: InvoiceData = {
    date: '15.11.2026',
    supplier: 'Поставщик Продуктов и Хозки',
    warehouse: 'kitchen',
    items: [
      { name: 'Сыр Сулугуни', qty: 2, price: 400, sum: 800, warehouse: 'kitchen' },
      { name: 'Перчатки латексные', qty: 1, price: 300, sum: 300, warehouse: 'household' }
    ]
  };

  const { invoiceId } = repo.saveInvoice(mixedInvoice);

  const syncResult = await workflow.confirmAndSync(invoiceId);

  // Must call kitchen first, then household sequentially
  assert.deepStrictEqual(callOrder, ['kitchen', 'household']);

  // Must fail overall because household failed
  assert.strictEqual(syncResult.success, false);
  assert.match(syncResult.message || '', /Кухня.*успешно создана/);
  assert.match(syncResult.message || '', /DOC-KIT-777/);
  assert.match(syncResult.message || '', /Хоз склад.*завершилась ошибкой/);

  // Status in DB must be recorded as 'synced' to prevent duplicate kitchen creation on retry!
  const saved = repo.getInvoice(invoiceId);
  assert.strictEqual(saved?.invoice.status, 'synced');
  assert.match(saved?.invoice.iiko_document_id || '', /DOC-KIT-777/);

  // Subsequent call must report already synced
  const retrySync = await workflow.confirmAndSync(invoiceId);
  assert.strictEqual(retrySync.success, false);
  assert.strictEqual(retrySync.alreadySynced, true);
  // No additional calls to iiko
  assert.strictEqual(callOrder.length, 2);
});

// 3. [IMPORTANT] False split due to partitionItemsByWarehouse ignoring invoice warehouse
test('partitionItemsByWarehouse respects defaultWarehouse parameter', () => {
  const items = [
    { name: 'Неизвестный Инвентарь XYZ', qty: 1, price: 500, sum: 500 }
  ];

  // Default kitchen
  const partKitchen = partitionItemsByWarehouse(items, 'kitchen');
  assert.strictEqual(partKitchen.isMixed, false);
  assert.strictEqual(partKitchen.kitchen.length, 1);
  assert.strictEqual(partKitchen.household.length, 0);

  // Default household
  const partHousehold = partitionItemsByWarehouse(items, 'household');
  assert.strictEqual(partHousehold.isMixed, false);
  assert.strictEqual(partHousehold.kitchen.length, 0);
  assert.strictEqual(partHousehold.household.length, 1);
});

// 4. [IMPORTANT] Remove 'стакан' and 'контейнер' from unconditional household roots
test('food products with стакан and контейнер are classified as kitchen', () => {
  const food1 = 'Сметана 20% стакан 400г';
  const food2 = 'Томаты черри контейнер 500г';
  const food3 = 'Йогурт клубничный стакан 125г';

  assert.strictEqual(isHouseholdItemName(food1), false, `${food1} must not be household root`);
  assert.strictEqual(isHouseholdItemName(food2), false, `${food2} must not be household root`);
  assert.strictEqual(isHouseholdItemName(food3), false, `${food3} must not be household root`);

  assert.strictEqual(classifyItemWarehouse(food1), 'kitchen');
  assert.strictEqual(classifyItemWarehouse(food2), 'kitchen');
  assert.strictEqual(classifyItemWarehouse(food3), 'kitchen');
});

// 5. [IMPORTANT] Prevent modification of synced invoices
test('workflow blocks all modifications for synced invoices', async () => {
  const repo = setupRepo();
  const workflow = new InvoiceWorkflow({ repo });

  const initialInvoice: InvoiceData = {
    date: '15.11.2026',
    supplier: 'Мясной Двор',
    warehouse: 'kitchen',
    items: [
      { name: 'Говядина вырезка', qty: 10, price: 900, sum: 9000 }
    ]
  };

  const { invoiceId } = repo.saveInvoice(initialInvoice);
  repo.updateInvoiceStatus(invoiceId, 'synced', 'DOC-999');

  // 1. applyHybridEdit
  const hybridRes = await workflow.applyHybridEdit(invoiceId, '1: 12 * 900');
  assert.strictEqual(hybridRes.success, false);
  assert.match(hybridRes.message || '', /уже была создана в iiko/);

  // 2. applyVoiceEdit
  const voiceRes = await workflow.applyVoiceEdit(invoiceId, Buffer.from('dummy'), 'audio/ogg');
  assert.strictEqual(voiceRes.success, false);
  assert.match(voiceRes.message || '', /уже была создана в iiko/);

  // 3. undoEdit
  const undoRes = workflow.undoEdit(invoiceId);
  assert.strictEqual(undoRes.success, false);
  assert.match(undoRes.message || '', /уже была создана в iiko/);

  // 4. deleteItem
  const deleteRes = workflow.deleteItem(invoiceId, 0);
  assert.strictEqual(deleteRes.success, false);
  assert.match(deleteRes.error || '', /уже была создана в iiko/);

  // 5. toggleWarehouse
  const toggleRes = workflow.toggleWarehouse(invoiceId);
  assert.strictEqual(toggleRes.success, false);
  assert.match(toggleRes.error || '', /уже была создана в iiko/);

  // 6. applyDataEdit
  const dataRes = workflow.applyDataEdit(invoiceId, {
    ...initialInvoice,
    supplier: 'Другой поставщик'
  });
  assert.strictEqual(dataRes.success, false);
  assert.match(dataRes.message || '', /уже была создана в iiko/);

  // 7. applyTextEdit
  const textRes = workflow.applyTextEdit(invoiceId, '1: 15 * 900');
  assert.strictEqual(textRes.success, false);
  assert.match(textRes.message || '', /уже была создана в iiko/);

  // 8. rejectInvoice
  const rejectRes = workflow.rejectInvoice(invoiceId);
  assert.strictEqual(rejectRes.success, false);
  assert.match(rejectRes.error || '', /уже была создана в iiko/);
});

// 6. [IMPORTANT] updateTelegramInvoiceCard uses stored card_message_id
test('updateTelegramInvoiceCard targets stored card_message_id and chat_id', async () => {
  const repo = setupRepo();
  const workflow = new InvoiceWorkflow({ repo });

  const invoiceData: InvoiceData = {
    date: '15.11.2026',
    supplier: 'Тест Поставщик',
    warehouse: 'kitchen',
    items: [{ name: 'Морковь', qty: 5, price: 30, sum: 150 }]
  };

  const { invoiceId } = repo.saveInvoice(invoiceData, undefined, 111, 222);
  // Set card_message_id in db
  repo.updateInvoiceTelegramMessage(invoiceId, 55555, 99999);

  let editedChatId: any = null;
  let editedMsgId: any = null;
  let editedText: any = null;

  const mockBot = {
    api: {
      editMessageText: async (chatId: any, messageId: any, text: string) => {
        editedChatId = chatId;
        editedMsgId = messageId;
        editedText = text;
        return true;
      }
    }
  } as any;

  const ok = await updateTelegramInvoiceCard(mockBot, workflow, invoiceId);
  assert.strictEqual(ok, true);
  assert.strictEqual(editedChatId, 55555);
  assert.strictEqual(editedMsgId, 99999);
  assert.match(editedText, /Тест Поставщик/);
});

// 7. [TEST CONCURRENCY & PORT] WebApp server returns actual port from AddressInfo
test('startWebAppServer returns actual bound port via AddressInfo', async () => {
  const repo = setupRepo();
  const workflow = new InvoiceWorkflow({ repo });

  // Use port 0 to bind to an OS-assigned ephemeral port
  const instance = startWebAppServer(workflow, 0);

  try {
    // Port must be a positive non-zero number assigned by OS
    await new Promise((resolve) => instance.server.once('listening', resolve));
    assert.ok(instance.port > 0, `Expected ephemeral port > 0, got ${instance.port}`);

    const res = await fetch(`http://localhost:${instance.port}/health`);
    assert.strictEqual(res.status, 200);
    const body = await res.json() as { status: string };
    assert.strictEqual(body.status, 'ok');
  } finally {
    await instance.stop();
  }
});
