import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getDatabase } from '../src/db/database.js';
import { InvoicesRepository } from '../src/db/invoices.repo.js';
import { InvoiceWorkflow } from '../src/workflow/invoice-workflow.js';
import { IikoClient, IikoCreateInvoiceResult } from '../src/iiko/client.js';
import { InvoiceData } from '../src/types/index.js';

const TEST_SPLIT_DB = './data/test_split.db';

function createTestRepo(): InvoicesRepository {
  if (fs.existsSync(TEST_SPLIT_DB)) {
    try { fs.unlinkSync(TEST_SPLIT_DB); } catch {}
  }
  const db = getDatabase(TEST_SPLIT_DB);
  return new InvoicesRepository(db);
}

test('InvoiceWorkflow splits mixed invoices into 2 iiko draft documents', async () => {
  const repo = createTestRepo();

  const createdInvoices: InvoiceData[] = [];
  const mockIikoClient = {
    isConfigured: () => true,
    createInvoice: async (data: InvoiceData): Promise<IikoCreateInvoiceResult> => {
      createdInvoices.push(data);
      const whCode = data.warehouse === 'household' ? 'HOU' : 'KIT';
      const docNum = `DOC-${whCode}-${createdInvoices.length}`;
      return {
        success: true,
        documentNumber: docNum,
        documentId: `guid-${docNum}`
      };
    }
  } as unknown as IikoClient;

  const workflow = new InvoiceWorkflow({
    repo,
    iikoClient: mockIikoClient
  });

  const mixedData: InvoiceData = {
    date: '15.11.2026',
    supplier: 'Метро Кэш энд Керри',
    warehouse: 'kitchen',
    items: [
      { name: 'Сыр Гауда', qty: 2, price: 500, sum: 1000, warehouse: 'kitchen' },
      { name: 'Помидоры', qty: 5, price: 150, sum: 750, warehouse: 'kitchen' },
      { name: 'Перчатки нитриловые', qty: 3, price: 250, sum: 750, warehouse: 'household' },
      { name: 'Салфетки бумажные', qty: 10, price: 40, sum: 400, warehouse: 'household' }
    ]
  };

  const { invoiceId } = repo.saveInvoice(mixedData);

  const syncRes = await workflow.confirmAndSync(invoiceId);

  assert.strictEqual(syncRes.success, true);
  assert.strictEqual(syncRes.isSplit, true);
  assert.strictEqual(createdInvoices.length, 2, 'Must call iiko createInvoice twice');

  // Verify first invoice is Kitchen
  assert.strictEqual(createdInvoices[0].warehouse, 'kitchen');
  assert.strictEqual(createdInvoices[0].items.length, 2);
  assert.strictEqual(createdInvoices[0].items[0].name, 'Сыр Гауда');
  assert.strictEqual(createdInvoices[0].items[1].name, 'Помидоры');

  // Verify second invoice is Household
  assert.strictEqual(createdInvoices[1].warehouse, 'household');
  assert.strictEqual(createdInvoices[1].items.length, 2);
  assert.strictEqual(createdInvoices[1].items[0].name, 'Перчатки нитриловые');
  assert.strictEqual(createdInvoices[1].items[1].name, 'Салфетки бумажные');

  // Verify both document numbers returned
  assert.strictEqual(syncRes.documentNumbers?.kitchen, 'DOC-KIT-1');
  assert.strictEqual(syncRes.documentNumbers?.household, 'DOC-HOU-2');

  // Verify DB updated
  const updated = repo.getInvoice(invoiceId);
  assert.strictEqual(updated?.invoice.status, 'synced');
  assert.match(updated?.invoice.iiko_document_id || '', /DOC-KIT-1/);
  assert.match(updated?.invoice.iiko_document_id || '', /DOC-HOU-2/);
});

test('InvoiceWorkflow creates 1 document when invoice items belong to single category', async () => {
  const repo = createTestRepo();

  const createdInvoices: InvoiceData[] = [];
  const mockIikoClient = {
    isConfigured: () => true,
    createInvoice: async (data: InvoiceData): Promise<IikoCreateInvoiceResult> => {
      createdInvoices.push(data);
      return {
        success: true,
        documentNumber: 'DOC-SINGLE-1'
      };
    }
  } as unknown as IikoClient;

  const workflow = new InvoiceWorkflow({
    repo,
    iikoClient: mockIikoClient
  });

  const kitchenOnly: InvoiceData = {
    date: '15.11.2026',
    supplier: 'Овощи Базар',
    warehouse: 'kitchen',
    items: [
      { name: 'Огурцы', qty: 10, price: 100, sum: 1000, warehouse: 'kitchen' },
      { name: 'Томаты', qty: 5, price: 150, sum: 750, warehouse: 'kitchen' }
    ]
  };

  const { invoiceId } = repo.saveInvoice(kitchenOnly);
  const syncRes = await workflow.confirmAndSync(invoiceId);

  assert.strictEqual(syncRes.success, true);
  assert.strictEqual(syncRes.isSplit, false);
  assert.strictEqual(createdInvoices.length, 1);
  assert.strictEqual(createdInvoices[0].warehouse, 'kitchen');
  assert.strictEqual(syncRes.documentNumber, 'DOC-SINGLE-1');
});

test('toggleWarehouse switches single category invoice items and sends to toggled warehouse', async () => {
  const repo = createTestRepo();
  const createdInvoices: InvoiceData[] = [];
  const mockIikoClient = {
    isConfigured: () => true,
    createInvoice: async (data: InvoiceData): Promise<IikoCreateInvoiceResult> => {
      createdInvoices.push(data);
      return { success: true, documentNumber: 'DOC-TOGGLE-1' };
    }
  } as unknown as IikoClient;

  const workflow = new InvoiceWorkflow({
    repo,
    iikoClient: mockIikoClient
  });

  const { invoiceId } = repo.saveInvoice({
    date: '15.11.2026',
    supplier: 'Овощи Базар',
    warehouse: 'kitchen',
    items: [
      { name: 'Огурцы', qty: 10, price: 100, sum: 1000, warehouse: 'kitchen' }
    ]
  });

  const toggleRes = workflow.toggleWarehouse(invoiceId);
  assert.strictEqual(toggleRes.success, true);
  assert.strictEqual(toggleRes.newWarehouse, 'household');

  const syncRes = await workflow.confirmAndSync(invoiceId);
  assert.strictEqual(syncRes.success, true);
  assert.strictEqual(createdInvoices.length, 1);
  assert.strictEqual(
    createdInvoices[0].warehouse,
    'household',
    'Invoice sent to iiko must be household after toggle!'
  );
});

