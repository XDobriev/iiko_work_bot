import test from 'node:test';
import assert from 'node:assert/strict';
import { InvoiceQueue, InvoiceQueueTelegramApi, InvoiceQueueTask } from '../src/bot/invoice-queue.js';
import { InvoiceWorkflow, ProcessInvoiceResult } from '../src/workflow/invoice-workflow.js';
import { InvoiceData } from '../src/types/index.js';

interface RecordedApiCall {
  type: 'send' | 'edit' | 'delete';
  chatId: number;
  messageId?: number;
  text?: string;
  time: number;
}

function createMockTelegramApi() {
  const calls: RecordedApiCall[] = [];
  let nextMsgId = 100;

  const api: InvoiceQueueTelegramApi = {
    async sendMessage(chatId: number, text: string) {
      nextMsgId++;
      calls.push({ type: 'send', chatId, messageId: nextMsgId, text, time: Date.now() });
      return { message_id: nextMsgId };
    },
    async editMessageText(chatId: number, messageId: number, text: string) {
      calls.push({ type: 'edit', chatId, messageId, text, time: Date.now() });
      return true;
    },
    async deleteMessage(chatId: number, messageId: number) {
      calls.push({ type: 'delete', chatId, messageId, time: Date.now() });
      return true;
    }
  };

  return { api, calls };
}

function createMockWorkflow(processingDelayMs = 20, shouldFailId?: number) {
  const processedTasks: Array<{ id: number; startedAt: number; finishedAt: number }> = [];
  let idCounter = 0;

  const mockData: InvoiceData = {
    date: '16.11.2026',
    supplier: 'Бойня Тест',
    warehouse: 'kitchen',
    items: [{ name: 'Мясо', qty: 10, price: 500, sum: 5000, unit: 'кг' }]
  };

  const workflow = {
    processPhotoInvoice: async (input: any): Promise<ProcessInvoiceResult> => {
      idCounter++;
      const currentId = idCounter;
      const startedAt = Date.now();

      if (input.onProgress) {
        input.onProgress({ elapsedSec: 0, active: true, model: 'test-model', attempt: 1 });
      }

      await new Promise(r => setTimeout(r, processingDelayMs));

      if (shouldFailId === currentId) {
        throw new Error(`Сбой обработки накладной #${currentId}`);
      }

      const finishedAt = Date.now();
      processedTasks.push({ id: currentId, startedAt, finishedAt });

      return {
        invoiceId: currentId,
        data: mockData,
        comparison: { previousInvoicesCount: 0, priceChanges: [], duplicateDetected: false },
        cardText: `Накладная #${currentId}`,
        hasPhoto: true
      };
    },
    processVoiceInvoice: async (input: any): Promise<ProcessInvoiceResult> => {
      idCounter++;
      const currentId = idCounter;
      const startedAt = Date.now();

      if (input.onProgress) {
        input.onProgress({ elapsedSec: 0, active: true, model: 'voice-model', attempt: 1 });
      }

      await new Promise(r => setTimeout(r, processingDelayMs));
      const finishedAt = Date.now();
      processedTasks.push({ id: currentId, startedAt, finishedAt });

      return {
        invoiceId: currentId,
        data: mockData,
        comparison: { previousInvoicesCount: 0, priceChanges: [], duplicateDetected: false },
        cardText: `🎙 Голосовая накладная #${currentId}`,
        hasPhoto: false
      };
    }
  } as unknown as InvoiceWorkflow;

  return { workflow, processedTasks };
}

test('InvoiceQueue executes tasks strictly sequentially (concurrency: 1) with FIFO order', async () => {
  const { api, calls } = createMockTelegramApi();
  const { workflow, processedTasks } = createMockWorkflow(50);
  const readyResults: ProcessInvoiceResult[] = [];

  const queue = new InvoiceQueue({
    workflow,
    api,
    interTaskDelayMs: 30, // 30ms guard for test speed
    progressIntervalMs: 20,
    onInvoiceReady: async (_task, res) => {
      readyResults.push(res);
    }
  });

  const dummyBuf1 = Buffer.from('img1');
  const dummyBuf2 = Buffer.from('img2');
  const dummyBuf3 = Buffer.from('img3');

  // Enqueue 3 tasks simultaneously (album simulation)
  const p1 = queue.enqueuePhoto({ chatId: 123, messageId: 10, photoBuffer: dummyBuf1 });
  const p2 = queue.enqueuePhoto({ chatId: 123, messageId: 11, photoBuffer: dummyBuf2 });
  const p3 = queue.enqueuePhoto({ chatId: 123, messageId: 12, photoBuffer: dummyBuf3 });

  const [res1, res2, res3] = await Promise.all([p1, p2, p3]);

  assert.strictEqual(res1.invoiceId, 1);
  assert.strictEqual(res2.invoiceId, 2);
  assert.strictEqual(res3.invoiceId, 3);
  assert.strictEqual(readyResults.length, 3);

  // Verify sequential execution: task N+1 started after task N finished
  assert.strictEqual(processedTasks.length, 3);
  assert.ok(processedTasks[1].startedAt >= processedTasks[0].finishedAt, 'Task 2 must start after Task 1 completes');
  assert.ok(processedTasks[2].startedAt >= processedTasks[1].finishedAt, 'Task 3 must start after Task 2 completes');

  // Verify RPM delay was applied between tasks (at least 20ms)
  const delay1to2 = processedTasks[1].startedAt - processedTasks[0].finishedAt;
  const delay2to3 = processedTasks[2].startedAt - processedTasks[1].finishedAt;
  assert.ok(delay1to2 >= 25, `Expected interTaskDelay >= 25ms, got ${delay1to2}ms`);
  assert.ok(delay2to3 >= 25, `Expected interTaskDelay >= 25ms, got ${delay2to3}ms`);
});

test('InvoiceQueue sends immediate queue position messages and deletes status message on completion', async () => {
  const { api, calls } = createMockTelegramApi();
  const { workflow } = createMockWorkflow(40);

  const queue = new InvoiceQueue({
    workflow,
    api,
    interTaskDelayMs: 20,
    progressIntervalMs: 15
  });

  // Task 1
  const p1 = queue.enqueuePhoto({ chatId: 100, messageId: 1, photoBuffer: Buffer.from('photo1') });
  // Task 2
  const p2 = queue.enqueuePhoto({ chatId: 100, messageId: 2, photoBuffer: Buffer.from('photo2') });
  // Task 3
  const p3 = queue.enqueuePhoto({ chatId: 100, messageId: 3, photoBuffer: Buffer.from('photo3') });

  await Promise.all([p1, p2, p3]);

  // Find queue notification messages
  const queueNotifications = calls.filter(c => c.type === 'send' && c.text?.includes('Накладная добавлена в очередь'));
  assert.strictEqual(queueNotifications.length, 2, 'Tasks 2 and 3 should receive queue position notifications');
  assert.match(queueNotifications[0].text!, /#2 из 2/);
  assert.match(queueNotifications[1].text!, /#3 из 3/);

  // Check deletions: each completed task should have its status message deleted
  const deleteCalls = calls.filter(c => c.type === 'delete');
  assert.strictEqual(deleteCalls.length, 3, 'All 3 status messages should be deleted upon completion');

  // Check batch counter reset after queue drains
  assert.strictEqual(queue.getBatchCounter(), 0);
  assert.strictEqual(queue.getQueueLength(), 0);
  assert.strictEqual(queue.isBusy(), false);
});

test('InvoiceQueue is error resilient: failed task reports error and does not block subsequent tasks', async () => {
  const { api, calls } = createMockTelegramApi();
  // Task #2 will throw an error
  const { workflow, processedTasks } = createMockWorkflow(30, 2);
  let errorCaughtOnTask2 = false;

  const queue = new InvoiceQueue({
    workflow,
    api,
    interTaskDelayMs: 20,
    progressIntervalMs: 15
  });

  const p1 = queue.enqueuePhoto({ chatId: 200, messageId: 1, photoBuffer: Buffer.from('photo1') });
  const p2 = queue.enqueuePhoto({ chatId: 200, messageId: 2, photoBuffer: Buffer.from('photo2') })
    .catch((err) => {
      errorCaughtOnTask2 = true;
      assert.match(err.message, /Сбой обработки накладной #2/);
    });
  const p3 = queue.enqueuePhoto({ chatId: 200, messageId: 3, photoBuffer: Buffer.from('photo3') });

  await Promise.all([p1, p2, p3]);

  assert.strictEqual(errorCaughtOnTask2, true);
  // Task 3 must have succeeded despite task 2 error!
  assert.strictEqual(processedTasks.length, 2, 'Tasks 1 and 3 should be recorded in processedTasks');

  // Error message must be edited into task 2's status message
  const errorEdits = calls.filter(c => c.type === 'edit' && c.text?.includes('Ошибка распознавания'));
  assert.strictEqual(errorEdits.length, 1);
  assert.match(errorEdits[0].text!, /Сбой обработки накладной #2/);

  // Queue should be completely empty and reset
  assert.strictEqual(queue.getQueueLength(), 0);
  assert.strictEqual(queue.isBusy(), false);
});

test('InvoiceQueue supports voice recognition tasks in same queue pipeline', async () => {
  const { api, calls } = createMockTelegramApi();
  const { workflow } = createMockWorkflow(25);

  const queue = new InvoiceQueue({
    workflow,
    api,
    interTaskDelayMs: 15,
    progressIntervalMs: 10
  });

  const photoP = queue.enqueuePhoto({ chatId: 300, messageId: 1, photoBuffer: Buffer.from('photo') });
  const voiceP = queue.enqueueVoice({ chatId: 300, messageId: 2, audioBuffer: Buffer.from('audio'), audioMimeType: 'audio/ogg' });

  const [photoRes, voiceRes] = await Promise.all([photoP, voiceP]);

  assert.strictEqual(photoRes.hasPhoto, true);
  assert.strictEqual(voiceRes.hasPhoto, false);
  assert.match(voiceRes.cardText, /Голосовая накладная/);

  const deleteCalls = calls.filter(c => c.type === 'delete');
  assert.strictEqual(deleteCalls.length, 2);
});

test('InvoiceQueue handles task #1 failure cleanly and continues subsequent tasks', async () => {
  const { api, calls } = createMockTelegramApi();
  // Task 1 fails
  const { workflow, processedTasks } = createMockWorkflow(25, 1);
  let errorCaught = false;

  const queue = new InvoiceQueue({
    workflow,
    api,
    interTaskDelayMs: 15,
    progressIntervalMs: 10
  });

  const p1 = queue.enqueuePhoto({ chatId: 400, messageId: 1, photoBuffer: Buffer.from('photo1') })
    .catch((err) => {
      errorCaught = true;
      assert.match(err.message, /Сбой обработки накладной #1/);
    });
  const p2 = queue.enqueuePhoto({ chatId: 400, messageId: 2, photoBuffer: Buffer.from('photo2') });

  await Promise.all([p1, p2]);

  assert.strictEqual(errorCaught, true);
  assert.strictEqual(processedTasks.length, 1);
  assert.strictEqual(processedTasks[0].id, 2);
  assert.strictEqual(queue.getQueueLength(), 0);
  assert.strictEqual(queue.isBusy(), false);
});

test('InvoiceQueue continues processing even if Telegram editMessageText or deleteMessage fails', async () => {
  let nextMsgId = 500;
  const calls: RecordedApiCall[] = [];

  const failingApi: InvoiceQueueTelegramApi = {
    async sendMessage(chatId: number, text: string) {
      nextMsgId++;
      calls.push({ type: 'send', chatId, messageId: nextMsgId, text, time: Date.now() });
      return { message_id: nextMsgId };
    },
    async editMessageText() {
      throw new Error('Telegram API: message is not modified or forbidden');
    },
    async deleteMessage() {
      throw new Error('Telegram API: message cannot be deleted');
    }
  };

  const { workflow, processedTasks } = createMockWorkflow(20);

  const queue = new InvoiceQueue({
    workflow,
    api: failingApi,
    interTaskDelayMs: 10,
    progressIntervalMs: 5
  });

  const p1 = queue.enqueuePhoto({ chatId: 500, messageId: 1, photoBuffer: Buffer.from('p1') });
  const p2 = queue.enqueuePhoto({ chatId: 500, messageId: 2, photoBuffer: Buffer.from('p2') });

  const [r1, r2] = await Promise.all([p1, p2]);

  assert.strictEqual(r1.invoiceId, 1);
  assert.strictEqual(r2.invoiceId, 2);
  assert.strictEqual(processedTasks.length, 2);
  assert.strictEqual(queue.getQueueLength(), 0);
  assert.strictEqual(queue.isBusy(), false);
});

test('InvoiceQueue prevents deadlock when Telegram sendMessage is slower than fast invoice processing', async () => {
  const processedOrder: number[] = [];
  let nextMsgId = 600;

  const slowApi: InvoiceQueueTelegramApi = {
    async sendMessage(_chatId: number, text: string) {
      nextMsgId++;
      if (text.includes('очередь')) {
        // Queue notification takes 60ms to send over network
        await new Promise(r => setTimeout(r, 60));
      }
      return { message_id: nextMsgId };
    },
    async editMessageText() { return true; },
    async deleteMessage() { return true; }
  };

  const workflow = {
    processPhotoInvoice: async (input: any): Promise<ProcessInvoiceResult> => {
      // Fast task #1 takes only 15ms
      await new Promise(r => setTimeout(r, 15));
      const id = input.photoFileId === 'photo_1' ? 1 : 2;
      processedOrder.push(id);
      return {
        invoiceId: id,
        data: {} as any,
        comparison: { previousInvoicesCount: 0, priceChanges: [], duplicateDetected: false },
        cardText: `Invoice #${id}`,
        hasPhoto: true
      };
    }
  } as unknown as InvoiceWorkflow;

  const queue = new InvoiceQueue({
    workflow,
    api: slowApi,
    interTaskDelayMs: 10,
    progressIntervalMs: 5
  });

  const p1 = queue.enqueuePhoto({ chatId: 600, messageId: 1, photoBuffer: Buffer.from('1'), photoFileId: 'photo_1' });
  // Small delay so task #1 starts immediately and is busy
  await new Promise(r => setTimeout(r, 5));
  const p2 = queue.enqueuePhoto({ chatId: 600, messageId: 2, photoBuffer: Buffer.from('2'), photoFileId: 'photo_2' });

  const [res1, res2] = await Promise.all([p1, p2]);

  assert.strictEqual(res1.invoiceId, 1);
  assert.strictEqual(res2.invoiceId, 2);
  assert.deepStrictEqual(processedOrder, [1, 2], 'Both tasks must complete in FIFO order without deadlock');
  assert.strictEqual(queue.getQueueLength(), 0);
  assert.strictEqual(queue.isBusy(), false);
});

test('InvoiceQueue guarantees strict FIFO ordering even if Telegram network latency fluctuates', async () => {
  const executionOrder: string[] = [];
  let nextMsgId = 700;

  const fluctuatingApi: InvoiceQueueTelegramApi = {
    async sendMessage(_chatId: number, text: string) {
      nextMsgId++;
      // Task 1 initial message takes longer (50ms) than Task 2 queue message (10ms)
      if (text.includes('Разбираю')) {
        await new Promise(r => setTimeout(r, 50));
      } else {
        await new Promise(r => setTimeout(r, 10));
      }
      return { message_id: nextMsgId };
    },
    async editMessageText() { return true; },
    async deleteMessage() { return true; }
  };

  const workflow = {
    processPhotoInvoice: async (input: any): Promise<ProcessInvoiceResult> => {
      executionOrder.push(input.photoFileId);
      return {
        invoiceId: 1,
        data: {} as any,
        comparison: { previousInvoicesCount: 0, priceChanges: [], duplicateDetected: false },
        cardText: 'Card',
        hasPhoto: true
      };
    }
  } as unknown as InvoiceWorkflow;

  const queue = new InvoiceQueue({
    workflow,
    api: fluctuatingApi,
    interTaskDelayMs: 10,
    progressIntervalMs: 5
  });

  const p1 = queue.enqueuePhoto({ chatId: 700, messageId: 1, photoBuffer: Buffer.from('1'), photoFileId: 'task_alpha' });
  const p2 = queue.enqueuePhoto({ chatId: 700, messageId: 2, photoBuffer: Buffer.from('2'), photoFileId: 'task_beta' });

  await Promise.all([p1, p2]);

  assert.deepStrictEqual(executionOrder, ['task_alpha', 'task_beta'], 'First enqueued task must ALWAYS be executed first');
});
