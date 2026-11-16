import test from 'node:test';
import assert from 'node:assert';
import { InvoiceWorkflow } from '../src/workflow/invoice-workflow.js';
import { GeminiInvoiceRecognizer, RecognizerOptions } from '../src/gemini/recognizer.js';
import { InvoicesRepository } from '../src/db/invoices.repo.js';
import { IikoClient } from '../src/iiko/client.js';
import { InvoiceData } from '../src/types/index.js';
import { InvoiceQueue } from '../src/bot/invoice-queue.js';
import { getDatabase } from '../src/db/database.js';

test('GeminiInvoiceRecognizer includes userHint in prompt', () => {
  const recognizer = new GeminiInvoiceRecognizer('dummy-key', ['dummy-model']);
  // Use private method via any for isolated unit check
  const prompt = (recognizer as any).buildSystemPrompt({
    userHint: 'Хоз склад, обрати внимание на мыло'
  } as RecognizerOptions, false);

  assert.ok(prompt.includes('Хоз склад, обрати внимание на мыло'));
  assert.ok(prompt.includes('Комментарий/подсказка пользователя к этой накладной'));
});

test('processPhotoInvoice passes caption as userHint and applies explicit warehouse and supplier overrides', async () => {
  const memDb = getDatabase(':memory:');
  const repo = new InvoicesRepository(memDb);

  let capturedOptions: RecognizerOptions | undefined;

  const mockRecognizer = {
    recognize: async (_buf: Buffer, options: RecognizerOptions = {}) => {
      capturedOptions = options;
      const dummyData: InvoiceData = {
        date: '15.05.2026',
        supplier: 'Оригинальный поставщик',
        warehouse: 'kitchen',
        items: [
          { name: 'Мыло жидкое', qty: 2, price: 150, sum: 300, unit: 'шт', warehouse: 'kitchen' },
          { name: 'Перчатки', qty: 5, price: 100, sum: 500, unit: 'уп', warehouse: 'kitchen' }
        ],
        total_written: 800,
        model_used: 'mock-model'
      };
      return dummyData;
    }
  } as unknown as GeminiInvoiceRecognizer;

  const mockIiko = {
    getProducts: async () => [],
    clearCache: () => {}
  } as unknown as IikoClient;

  const workflow = new InvoiceWorkflow({
    repo,
    iikoClient: mockIiko,
    recognizer: mockRecognizer
  });

  // Run with photo caption overriding warehouse to household and supplier to ИП Смирнов
  const result = await workflow.processPhotoInvoice({
    photoBuffer: Buffer.from('test-photo'),
    caption: 'Хоз склад\nПоставщик: ИП Смирнов'
  });

  // Verify options passed to recognizer
  assert.strictEqual(capturedOptions?.userHint, 'Хоз склад\nПоставщик: ИП Смирнов');

  // Verify deterministic overrides applied to parsed invoice
  assert.strictEqual(result.data.warehouse, 'household', 'Warehouse must be overridden to household');
  assert.strictEqual(result.data.supplier, 'ИП Смирнов', 'Supplier must be overridden to ИП Смирнов');
  assert.strictEqual(result.data.items[0].warehouse, 'household');
  assert.strictEqual(result.data.items[1].warehouse, 'household');
});

test('InvoiceQueue propagates caption to processPhotoInvoice', async () => {
  let capturedCaption: string | undefined;

  const mockWorkflow = {
    processPhotoInvoice: async (input: { caption?: string }) => {
      capturedCaption = input.caption;
      return {
        invoiceId: 99,
        data: {
          date: '16.05.2026',
          supplier: 'Тест',
          warehouse: 'kitchen',
          items: [],
          total_written: null
        },
        comparison: [],
        cardText: 'Card',
        hasPhoto: true
      };
    }
  } as unknown as InvoiceWorkflow;

  const mockApi = {
    sendMessage: async () => ({ message_id: 1 }),
    editMessageText: async () => {},
    deleteMessage: async () => {}
  };

  const queue = new InvoiceQueue({
    workflow: mockWorkflow,
    api: mockApi,
    interTaskDelayMs: 0
  });

  await queue.enqueuePhoto({
    chatId: 12345,
    messageId: 67890,
    photoBuffer: Buffer.from('photo'),
    caption: 'Хозтовары'
  });

  assert.strictEqual(capturedCaption, 'Хозтовары', 'Caption must be forwarded through queue');
});
