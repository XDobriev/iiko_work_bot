import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getDatabase } from '../src/db/database.js';
import { InvoicesRepository } from '../src/db/invoices.repo.js';
import { InvoiceWorkflow } from '../src/workflow/invoice-workflow.js';
import { InvoiceData } from '../src/types/index.js';
import { GeminiInvoiceRecognizer } from '../src/gemini/recognizer.js';
import { IikoClient } from '../src/iiko/client.js';

const TEST_DB_PATH = './data/test_workflow.db';
const TEST_PHOTOS_DIR = './data/test_workflow_photos';

class MockRecognizer extends GeminiInvoiceRecognizer {
  private mockData: InvoiceData;

  constructor(mockData: InvoiceData) {
    super('mock-key', 'mock-model');
    this.mockData = mockData;
  }

  async recognize(): Promise<InvoiceData> {
    return JSON.parse(JSON.stringify(this.mockData));
  }

  async recognizeVoice(): Promise<InvoiceData> {
    return JSON.parse(JSON.stringify(this.mockData));
  }
}

class MockIikoClient extends IikoClient {
  constructor(repo?: InvoicesRepository) {
    super(repo);
  }

  isConfigured(): boolean {
    return false; // Triggers safe mock mode
  }
}

function setupWorkflow(mockData: InvoiceData): { workflow: InvoiceWorkflow; repo: InvoicesRepository } {
  if (fs.existsSync(TEST_DB_PATH)) {
    try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  }
  if (fs.existsSync(TEST_PHOTOS_DIR)) {
    try { fs.rmSync(TEST_PHOTOS_DIR, { recursive: true, force: true }); } catch {}
  }

  const db = getDatabase(TEST_DB_PATH);
  const repo = new InvoicesRepository(db);
  const recognizer = new MockRecognizer(mockData);
  const iikoClient = new MockIikoClient(repo);

  const workflow = new InvoiceWorkflow({
    repo,
    recognizer,
    iikoClient,
    photosDir: TEST_PHOTOS_DIR
  });

  return { workflow, repo };
}

test('InvoiceWorkflow full lifecycle: photo -> edit -> toggle warehouse -> delete -> sync', async () => {
  const initialInvoice: InvoiceData = {
    date: '20.11.2026',
    supplier: 'Бойня',
    warehouse: 'kitchen',
    items: [
      { name: 'Говядина', qty: 10, price: 600, sum: 6000, unit: 'кг' },
      { name: 'Баранина', qty: 5, price: 700, sum: 3500, unit: 'кг' }
    ],
    total_written: 9500
  };

  const { workflow, repo } = setupWorkflow(initialInvoice);

  // 1. Process Photo Invoice
  const photoBuffer = Buffer.from('fake-photo-data');
  const photoRes = await workflow.processPhotoInvoice({
    photoBuffer,
    userId: 999,
    messageId: 101,
    photoFileId: 'telegram-file-id-101'
  });

  assert.ok(photoRes.invoiceId > 0);
  assert.strictEqual(photoRes.data.supplier, 'Бойня');
  assert.strictEqual(photoRes.hasPhoto, true);
  assert.match(photoRes.cardText, /Накладная #/);
  assert.match(photoRes.cardText, /Бойня/);

  const savedPhotoPath = workflow.getPhotoPath(photoRes.invoiceId);
  assert.ok(savedPhotoPath);
  assert.strictEqual(fs.existsSync(savedPhotoPath), true);

  // Verify local_photo_path is persisted in DB record
  const initialDomain = repo.getInvoice(photoRes.invoiceId);
  assert.strictEqual(initialDomain?.invoice.local_photo_path, savedPhotoPath);

  // 2. Toggle Warehouse
  const whRes = workflow.toggleWarehouse(photoRes.invoiceId);
  assert.strictEqual(whRes.success, true);
  assert.strictEqual(whRes.newWarehouse, 'household');
  assert.match(whRes.cardText || '', /Хоз склад/);

  // Toggle back to kitchen
  const whRes2 = workflow.toggleWarehouse(photoRes.invoiceId);
  assert.strictEqual(whRes2.success, true);
  assert.strictEqual(whRes2.newWarehouse, 'kitchen');
  assert.match(whRes2.cardText || '', /Склад Кухня/);

  // 3. Apply Text Edit: line 1 quantity & price
  const editRes1 = workflow.applyTextEdit(photoRes.invoiceId, '1: 15 * 620');
  assert.strictEqual(editRes1.success, true);
  assert.strictEqual(editRes1.data?.items[0].qty, 15);
  assert.strictEqual(editRes1.data?.items[0].price, 620);
  assert.strictEqual(editRes1.data?.items[0].sum, 9300);

  // 4. Apply Text Edit: add new item
  const editRes2 = workflow.applyTextEdit(photoRes.invoiceId, '+ Кинза 2 * 150');
  assert.strictEqual(editRes2.success, true);
  assert.strictEqual(editRes2.data?.items.length, 3);
  assert.strictEqual(editRes2.data?.items[2].name, 'Кинза');

  // 5. Delete item by index (delete item 1, which is Баранина)
  const delRes = workflow.deleteItem(photoRes.invoiceId, 1);
  assert.strictEqual(delRes.success, true);
  assert.strictEqual(delRes.removedItem?.name, 'Баранина');
  assert.strictEqual(delRes.data?.items.length, 2);
  assert.strictEqual(delRes.data?.items[0].name, 'Говядина');
  assert.strictEqual(delRes.data?.items[1].name, 'Кинза');

  // 6. Confirm and sync with iiko (Mock mode)
  const syncRes = await workflow.confirmAndSync(photoRes.invoiceId);
  assert.strictEqual(syncRes.success, true);
  assert.strictEqual(syncRes.isMock, true);
  assert.ok(syncRes.documentNumber?.startsWith('MOCK-'));

  // Status in DB must now be 'synced'
  const domain = repo.getInvoice(photoRes.invoiceId);
  assert.strictEqual(domain?.invoice.status, 'synced');
  assert.strictEqual(domain?.invoice.iiko_document_id, syncRes.documentNumber);

  // Repeated sync attempt must be blocked
  const resync = await workflow.confirmAndSync(photoRes.invoiceId);
  assert.strictEqual(resync.success, false);
  assert.strictEqual(resync.alreadySynced, true);
});

test('InvoiceWorkflow supports voice recognition and rejection', async () => {
  const initialInvoice: InvoiceData = {
    date: '21.11.2026',
    supplier: 'Овощная База',
    warehouse: 'kitchen',
    items: [
      { name: 'Помидоры', qty: 20, price: 150, sum: 3000, unit: 'кг' }
    ]
  };

  const { workflow, repo } = setupWorkflow(initialInvoice);

  // Process voice
  const voiceRes = await workflow.processVoiceInvoice({
    audioBuffer: Buffer.from('fake-audio-ogg'),
    mimeType: 'audio/ogg',
    userId: 888
  });

  assert.ok(voiceRes.invoiceId > 0);
  assert.strictEqual(voiceRes.hasPhoto, false);
  assert.match(voiceRes.cardText, /Голосовая накладная/);

  // Reject invoice
  const rejectRes = workflow.rejectInvoice(voiceRes.invoiceId);
  assert.strictEqual(rejectRes.success, true);

  const domain = repo.getInvoice(voiceRes.invoiceId);
  assert.strictEqual(domain?.invoice.status, 'rejected');
});
