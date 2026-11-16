import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../src/db/database.js';
import { InvoicesRepository } from '../src/db/invoices.repo.js';
import { IikoClient } from '../src/iiko/client.js';
import { GeminiAutopilot, AutopilotPlan } from '../src/gemini/model-selection.js';
import { InvoiceQueue } from '../src/bot/invoice-queue.js';
import { InvoiceWorkflow, ProcessInvoiceResult } from '../src/workflow/invoice-workflow.js';
import {
  startWebAppServer,
  validateTelegramInitData,
  extractTelegramInitData
} from '../src/webapp/server.js';
import { escapeHtml, clampTelegramHtml, formatInvoiceMessage } from '../src/bot/formatter.js';
import { evaluateMath } from '../src/bot/parser.js';
import { InvoiceData } from '../src/types/index.js';
import { config } from '../src/config.js';

// --- Test Helper: Telegram initData Generator ---
function generateTestInitData(botToken: string, user: { id: number; first_name?: string }, authDate?: number): string {
  const date = authDate ?? Math.floor(Date.now() / 1000);
  const params: Record<string, string> = {
    auth_date: String(date),
    query_id: 'AAHdF6IQAAAAAN0XohD9e8_y',
    user: JSON.stringify(user)
  };

  const entries = Object.entries(params).sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const urlParams = new URLSearchParams(params);
  urlParams.set('hash', hash);
  return urlParams.toString();
}

// -------------------------------------------------------------
// 1. P1.1: SQLite Transactions in InvoicesRepository
// -------------------------------------------------------------
test('P1.1: InvoicesRepository atomicity - saveInvoice, updateInvoiceData, deleteInvoice', () => {
  const memDb = getDatabase(':memory:');
  const repo = new InvoicesRepository(memDb);

  const initialData: InvoiceData = {
    date: '16.11.2026',
    supplier: 'Поставщик Мяса',
    warehouse: 'kitchen',
    items: [
      { name: 'Говядина', qty: 10, price: 500, sum: 5000, unit: 'кг' },
      { name: 'Баранина', qty: 5, price: 600, sum: 3000, unit: 'кг' }
    ],
    total_written: 8000
  };

  // 1a. saveInvoice inside transaction
  const { invoiceId, totalCalculated } = repo.saveInvoice(initialData);
  assert.equal(totalCalculated, 8000);
  assert.ok(invoiceId > 0);

  const saved = repo.getInvoice(invoiceId);
  assert.ok(saved);
  assert.equal(saved.items.length, 2);

  // 1b. updateInvoiceData inside transaction
  const updatedData: InvoiceData = {
    ...initialData,
    items: [
      { name: 'Говядина Вырезка', qty: 12, price: 550, sum: 6600, unit: 'кг' }
    ]
  };
  const updatedOk = repo.updateInvoiceData(invoiceId, updatedData);
  assert.equal(updatedOk, true);

  const afterUpdate = repo.getInvoice(invoiceId);
  assert.ok(afterUpdate);
  assert.equal(afterUpdate.items.length, 1);
  assert.equal(afterUpdate.items[0].name, 'Говядина Вырезка');

  // 1c. deleteInvoice removes invoice, items, and snapshots atomically
  repo.pushSnapshot(invoiceId, initialData);
  assert.equal(repo.hasSnapshot(invoiceId), true);

  const deletedOk = repo.deleteInvoice(invoiceId);
  assert.equal(deletedOk, true);

  assert.equal(repo.getInvoice(invoiceId), null);
  assert.equal(repo.hasSnapshot(invoiceId), false);
  const leftoverItems = memDb.prepare('SELECT COUNT(*) as count FROM invoice_items WHERE invoice_id = ?').get(invoiceId) as { count: number };
  assert.equal(leftoverItems.count, 0);
});

test('P1.1: InvoicesRepository updateInvoiceData rolls back on failure without corrupting items', () => {
  const memDb = getDatabase(':memory:');
  const repo = new InvoicesRepository(memDb);

  const data: InvoiceData = {
    date: '16.11.2026',
    supplier: 'Тест',
    warehouse: 'kitchen',
    items: [{ name: 'Сыр', qty: 2, price: 500, sum: 1000, unit: 'кг' }]
  };
  const { invoiceId } = repo.saveInvoice(data);

  // Update non-existing invoice returns false and does not throw
  const res = repo.updateInvoiceData(999999, data);
  assert.equal(res, false);

  // Original invoice remains intact
  const orig = repo.getInvoice(invoiceId);
  assert.ok(orig);
  assert.equal(orig.items.length, 1);
});

// -------------------------------------------------------------
// 2. P1.2: Session Protection & Mutex in IikoClient
// -------------------------------------------------------------
test('P1.2: IikoClient does not call destructive logout in createInvoice', async () => {
  const client = new IikoClient();
  (client as any).password = undefined; // Force mock/dry-run mode
  let logoutCalled = false;
  client.logout = async () => {
    logoutCalled = true;
  };

  // Mock mode execution
  const res = await client.createInvoice({
    date: '16.11.2026',
    supplier: 'Тест',
    warehouse: 'kitchen',
    items: [{ name: 'Тест', qty: 1, price: 100, sum: 100, unit: 'шт' }]
  });

  assert.equal(res.success, true);
  assert.equal(logoutCalled, false, 'createInvoice must NOT call logout in finally block');
});

test('P1.2: IikoClient authenticate deduplicates concurrent login requests', async () => {
  const client = new IikoClient();
  let authCounter = 0;

  // Mock authenticate internal behavior by checking authPromise serialization
  (client as any).password = 'test-pass';
  (client as any).url = 'https://mock.iiko.local';
  (client as any).login = 'test-user';

  // Replace global fetch temporarily to measure concurrent auth calls
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: any) => {
    if (String(url).includes('/api/auth/login')) {
      authCounter++;
      await new Promise(r => setTimeout(r, 40));
      return {
        ok: true,
        text: async () => JSON.stringify({ success: true }),
        headers: {
          getSetCookie: () => ['PHPSESSID=session_test_123; path=/']
        }
      } as any;
    }
    return { ok: true, text: async () => '{}' } as any;
  };

  try {
    // Launch 3 simultaneous authenticate calls
    const [a1, a2, a3] = await Promise.all([
      (client as any).authenticate(),
      (client as any).authenticate(),
      (client as any).authenticate()
    ]);

    assert.equal(authCounter, 1, 'Concurrent authenticate calls must be deduplicated into a single network call');
    assert.equal((client as any).cookie, 'PHPSESSID=session_test_123');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// -------------------------------------------------------------
// 3. P1.3: Autopilot Stale-While-Revalidate
// -------------------------------------------------------------
test('P1.3: GeminiAutopilot getPlan implements Stale-While-Revalidate when TTL expires', async () => {
  const autopilot = new GeminiAutopilot('dummy-key', 100);
  let backgroundRefreshTriggered = false;

  autopilot.refresh = async (force?: boolean) => {
    if (force) {
      backgroundRefreshTriggered = true;
    }
    return (autopilot as any).currentPlan;
  };

  const expiredPlan: AutopilotPlan = {
    photoModels: ['stale-model-1'],
    voiceModels: ['stale-voice-1'],
    complexModels: ['stale-complex-1'],
    generalModels: ['stale-general-1'],
    benchmarkedAt: new Date(Date.now() - 100000).toISOString(),
    expiresAt: new Date(Date.now() - 1000).toISOString(), // expired in past
    models: [],
    rejectedModels: [],
    fromFallback: false
  };

  (autopilot as any).currentPlan = expiredPlan;

  // Call getPlan()
  const returnedPlan = autopilot.getPlan();

  // Must return stale plan immediately without throwing or blocking
  assert.equal(returnedPlan.photoModels[0], 'stale-model-1');
  assert.equal(backgroundRefreshTriggered, true, 'getPlan must fire background refresh when TTL expired');
});

// -------------------------------------------------------------
// 4. P1.4: InvoiceQueue Error Phase Separation
// -------------------------------------------------------------
test('P1.4: InvoiceQueue separates recognition errors from presentation delivery errors', async () => {
  const sentMessages: string[] = [];
  const editedMessages: string[] = [];

  const mockApi = {
    async sendMessage(_chatId: number, text: string) {
      sentMessages.push(text);
      return { message_id: 555 };
    },
    async editMessageText(_chatId: number, _messageId: number, text: string) {
      editedMessages.push(text);
      return true;
    },
    async deleteMessage(_chatId: number, _messageId: number) {
      return true;
    }
  };

  const mockWorkflow = {
    processPhotoInvoice: async (): Promise<ProcessInvoiceResult> => {
      // Recognition succeeds!
      return {
        invoiceId: 777,
        data: {
          date: '16.11.2026',
          supplier: 'Тест',
          warehouse: 'kitchen',
          items: [{ name: 'Мясо', qty: 5, price: 500, sum: 2500, unit: 'кг' }]
        },
        comparison: {} as any,
        cardText: 'Карточка накладной 777',
        hasPhoto: true
      };
    }
  } as unknown as InvoiceWorkflow;

  // onInvoiceReady intentionally throws (e.g. Telegram API HTML parse error or blocked bot)
  const queue = new InvoiceQueue({
    workflow: mockWorkflow,
    api: mockApi,
    interTaskDelayMs: 10,
    progressIntervalMs: 10,
    onInvoiceReady: async () => {
      throw new Error('Telegram API: can\'t parse entities');
    }
  });

  const photoP = queue.enqueuePhoto({
    chatId: 100,
    messageId: 10,
    photoBuffer: Buffer.from('photo')
  });

  await assert.rejects(async () => {
    await photoP;
  }, /Telegram API: can't parse entities/);

  // Verify: User is NOT told false "Ошибка распознавания"
  const falseRecogErr = sentMessages.some(m => m.includes('Ошибка распознавания'));
  assert.equal(falseRecogErr, false, 'Must NOT report false "Ошибка распознавания" when recognition succeeded');

  // Verify: User is informed that invoice 777 was successfully saved
  const successSavedNotice = sentMessages.some(m =>
    m.includes('Накладная #777 успешно распознана и сохранена') &&
    m.includes('возникла ошибка при отправке карточки в чат')
  );
  assert.equal(successSavedNotice, true, 'User must be informed invoice was saved and given command to view');
});

// -------------------------------------------------------------
// 5. P1.5: Telegram WebApp Server HMAC Authorization
// -------------------------------------------------------------
test('P1.5: validateTelegramInitData validates HMAC-SHA256 signature correctly', () => {
  const testBotToken = '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_test';
  const testUser = { id: 987654321, first_name: 'Хамзат' };

  // 5a. Valid initData
  const validInitData = generateTestInitData(testBotToken, testUser);
  const result = validateTelegramInitData(validInitData, testBotToken);
  assert.equal(result.isValid, true);
  assert.equal(result.user?.id, 987654321);

  // 5b. Tampered initData
  const tamperedInitData = validInitData.replace('987654321', '111111111');
  const tamperedResult = validateTelegramInitData(tamperedInitData, testBotToken);
  assert.equal(tamperedResult.isValid, false);
  assert.match(tamperedResult.error || '', /Invalid HMAC signature/);

  // 5c. Wrong bot token
  const wrongTokenResult = validateTelegramInitData(validInitData, '999999999:WRONG_TOKEN');
  assert.equal(wrongTokenResult.isValid, false);

  // 5d. Expired auth_date (older than 24h)
  const expiredInitData = generateTestInitData(testBotToken, testUser, Math.floor(Date.now() / 1000) - 90000);
  const expiredResult = validateTelegramInitData(expiredInitData, testBotToken);
  assert.equal(expiredResult.isValid, false);
  assert.match(expiredResult.error || '', /expired/);
});

test('P1.5: startWebAppServer blocks unauthorized API requests when requireAuth is enabled', async () => {
  const memDb = getDatabase(':memory:');
  const repo = new InvoicesRepository(memDb);
  const workflow = new InvoiceWorkflow({ repo });
  const testToken = '11223344:TEST_BOT_TOKEN';

  const { invoiceId } = repo.saveInvoice({
    date: '16.11.2026',
    supplier: 'Тест Поставщик',
    warehouse: 'kitchen',
    items: [{ name: 'Продукт', qty: 1, price: 100, sum: 100, unit: 'шт' }]
  });

  const TEST_PORT = 39820;
  const webapp = startWebAppServer(workflow, TEST_PORT, {
    requireAuth: true,
    botToken: testToken
  });

  try {
    const baseUrl = `http://localhost:${TEST_PORT}`;

    // 1. Health check is public
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);

    // 2. /api/invoice/:id without auth headers fails with 401
    const noAuthRes = await fetch(`${baseUrl}/api/invoice/${invoiceId}`);
    assert.equal(noAuthRes.status, 401);
    const noAuthJson = await noAuthRes.json() as { success: boolean; message: string };
    assert.equal(noAuthJson.success, false);
    assert.match(noAuthJson.message, /отсутствует initData/);

    // 3. /api/invoice/:id with invalid auth fails with 401
    const badAuthRes = await fetch(`${baseUrl}/api/invoice/${invoiceId}`, {
      headers: {
        'Authorization': 'tma auth_date=123&hash=invalid_hash'
      }
    });
    assert.equal(badAuthRes.status, 401);

    // 4. /api/invoice/:id with valid initData succeeds with 200
    const allowedUserId = config.telegram.allowedUserIds.length > 0
      ? config.telegram.allowedUserIds[0]
      : 12345;
    const validInitData = generateTestInitData(testToken, { id: allowedUserId });
    const goodAuthRes = await fetch(`${baseUrl}/api/invoice/${invoiceId}`, {
      headers: {
        'Authorization': `tma ${validInitData}`
      }
    });
    assert.equal(goodAuthRes.status, 200);
    const goodJson = await goodAuthRes.json() as { success: boolean; invoiceId: number };
    assert.equal(goodJson.success, true);
    assert.equal(goodJson.invoiceId, invoiceId);

    // 5. /api/invoice/:id with unauthorized user ID returns 403 when allowedUserIds is set
    if (config.telegram.allowedUserIds.length > 0) {
      const disallowedInitData = generateTestInitData(testToken, { id: 999999999 });
      const forbiddenRes = await fetch(`${baseUrl}/api/invoice/${invoiceId}`, {
        headers: {
          'Authorization': `tma ${disallowedInitData}`
        }
      });
      assert.equal(forbiddenRes.status, 403);
    }
  } finally {
    await webapp.stop();
  }
});

// -------------------------------------------------------------
// 6. P2.1: SQLite Foreign Key Index Verification
// -------------------------------------------------------------
test('P2.1: Database schema includes idx_items_invoice_id index on foreign key', () => {
  const db = getDatabase(':memory:');
  const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='invoice_items'`).all() as Array<{ name: string }>;
  const indexNames = indexes.map(i => i.name);
  assert.ok(indexNames.includes('idx_items_invoice_id'), 'idx_items_invoice_id index must exist on invoice_items');
});

// -------------------------------------------------------------
// 7. P2.2: Safe escapeHtml & Deterministic evaluateMath
// -------------------------------------------------------------
test('P2.2: escapeHtml handles non-string values safely without throwing', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(12345), '12345');
  assert.equal(escapeHtml('<b>Hello & Bye</b>'), '&lt;b&gt;Hello &amp; Bye&lt;/b&gt;');
});

test('P2.2: evaluateMath evaluates arithmetic expressions deterministically without new Function', () => {
  // Basic operations
  assert.equal(evaluateMath('4*6.5'), 26);
  assert.equal(evaluateMath('1250/5'), 250);
  assert.equal(evaluateMath('10 + 2.5'), 12.5);
  assert.equal(evaluateMath('100 - 35.5'), 64.5);

  // Precedence and parentheses
  assert.equal(evaluateMath('2 + 3 * 4'), 14);
  assert.equal(evaluateMath('(2 + 3) * 4'), 20);
  assert.equal(evaluateMath('4 * (6.5 + 1.5)'), 32);

  // Russian commas in numbers
  assert.equal(evaluateMath('4*6,5'), 26);
  assert.equal(evaluateMath('0,38 * 3'), 1.14);

  // Unary operators
  assert.equal(evaluateMath('-5 + 10'), 5);
  assert.equal(evaluateMath('5 * -2'), -10);

  // Safety checks
  assert.equal(evaluateMath(''), null);
  assert.equal(evaluateMath('console.log("hack")'), null);
  assert.equal(evaluateMath('1 / 0'), null, 'Division by zero must return null');
  assert.equal(evaluateMath('1.2.3'), null, 'Malformed float must return null');
  assert.equal(evaluateMath('((2+3)'), null, 'Unbalanced parens must return null');
});

// -------------------------------------------------------------
// 8. P2.3: Telegram 4096 Character Limit & Tag Balancing
// -------------------------------------------------------------
test('P2.3: clampTelegramHtml balances unclosed tags and limits length', () => {
  const longHtml = '<b>' + 'А'.repeat(5000) + '</b>';
  const clamped = clampTelegramHtml(longHtml, 3000);
  assert.ok(clamped.length <= 4096);
  assert.ok(clamped.includes('</b>'), 'Must close open <b> tag');
  assert.ok(clamped.includes('✂️'), 'Must include truncation notice');
});

test('P2.3: formatInvoiceMessage compacts huge invoices with 80 items within 4096 characters', () => {
  const hugeItems: any[] = [];
  for (let i = 1; i <= 80; i++) {
    hugeItems.push({
      name: `Продукт Номер ${i} Длинное Название`,
      qty: i,
      price: 150 + i * 5,
      sum: i * (150 + i * 5),
      unit: 'кг',
      warehouse: i % 2 === 0 ? 'household' : 'kitchen'
    });
  }

  const hugeInvoice: InvoiceData = {
    date: '16.11.2026',
    supplier: 'Огромный Оптовый Склад Поставок',
    warehouse: 'kitchen',
    items: hugeItems,
    total_written: 100000
  };

  const comparison = {
    isDuplicate: false,
    priceComparisons: [],
    totalPriceDelta: 0,
    mathDiscrepancy: false,
    discrepancyDiff: 0
  };

  const formattedCard = formatInvoiceMessage(999, hugeInvoice, comparison);

  assert.ok(formattedCard.length <= 4096, `Expected length <= 4096, got ${formattedCard.length}`);
  assert.ok(formattedCard.includes('ОБЩИЙ ИТОГ:'));
  assert.ok(formattedCard.includes('Накладная #999'));
});
