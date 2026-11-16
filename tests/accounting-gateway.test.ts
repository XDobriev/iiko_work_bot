import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LiveIikoAccountingGateway,
  MockIikoAccountingGateway
} from '../src/iiko/accounting-gateway.js';
import { InvoiceDomainRecord, InvoiceData } from '../src/types/index.js';
import { IikoClient } from '../src/iiko/client.js';

test('LiveIikoAccountingGateway serializes concurrent syncs with sessionMutex', async () => {
  let activeCalls = 0;
  let maxConcurrentCalls = 0;

  const mockClient = {
    getProducts: async () => [{ id: 'p1', name: 'Томаты', unit: 'кг' }],
    createInvoice: async () => {
      activeCalls++;
      maxConcurrentCalls = Math.max(maxConcurrentCalls, activeCalls);
      await new Promise(r => setTimeout(r, 40));
      activeCalls--;
      return { success: true, documentNumber: 'DOC-MUTEX-1' };
    }
  } as unknown as IikoClient;

  const gateway = new LiveIikoAccountingGateway({ client: mockClient });

  const domain: InvoiceDomainRecord = {
    invoice: {
      id: 1,
      date: '16.11.2026',
      supplier: 'Овощи',
      warehouse: 'kitchen',
      total_calculated: 100,
      total_written: 100,
      status: 'pending',
      created_at: '2026-11-16 12:00:00'
    },
    items: [],
    data: {
      date: '16.11.2026',
      supplier: 'Овощи',
      warehouse: 'kitchen',
      items: [{ name: 'Томаты', qty: 1, price: 100, sum: 100, unit: 'кг', warehouse: 'kitchen' }],
      total_written: 100
    }
  };

  // Launch 3 concurrent sync requests
  const results = await Promise.all([
    gateway.syncInvoice(domain),
    gateway.syncInvoice(domain),
    gateway.syncInvoice(domain)
  ]);

  assert.equal(maxConcurrentCalls, 1, 'Session mutex must prevent concurrent API invocations');
  assert.equal(results.length, 3);
  assert.ok(results.every(r => r.success));
});

test('LiveIikoAccountingGateway blocks sync if nomenclature contains unmatched items', async () => {
  const mockClient = {
    getProducts: async () => [{ id: 'p1', name: 'Томаты свежие', unit: 'кг' }],
    createInvoice: async () => {
      assert.fail('createInvoice should not be called when unmatched items exist');
    }
  } as unknown as IikoClient;

  const gateway = new LiveIikoAccountingGateway({ client: mockClient });

  const domain: InvoiceDomainRecord = {
    invoice: {
      id: 2,
      date: '16.11.2026',
      supplier: 'Овощи',
      warehouse: 'kitchen',
      total_calculated: 250,
      total_written: 250,
      status: 'pending',
      created_at: '2026-11-16 12:00:00'
    },
    items: [],
    data: {
      date: '16.11.2026',
      supplier: 'Овощи',
      warehouse: 'kitchen',
      items: [
        { name: 'Неизвестный экзотический фрукт xyz', qty: 1, price: 250, sum: 250, warehouse: 'kitchen' }
      ],
      total_written: 250
    }
  };

  const result = await gateway.syncInvoice(domain);
  assert.equal(result.success, false);
  assert.match(result.message || '', /несопоставленные позиции/i);
  assert.ok(result.unmatched?.includes('Неизвестный экзотический фрукт xyz'));
});

test('MockIikoAccountingGateway records calls and returns mock results', async () => {
  const gateway = new MockIikoAccountingGateway([
    { id: 'item-1', name: 'Сыр Фета', unit: 'кг' }
  ]);

  const domain: InvoiceDomainRecord = {
    invoice: {
      id: 99,
      date: '16.11.2026',
      supplier: 'Молоко',
      warehouse: 'kitchen',
      total_calculated: 500,
      total_written: 500,
      status: 'pending',
      created_at: '2026-11-16 12:00:00'
    },
    items: [],
    data: {
      date: '16.11.2026',
      supplier: 'Молоко',
      warehouse: 'kitchen',
      items: [{ name: 'Сыр Фета', qty: 2, price: 250, sum: 500, warehouse: 'kitchen' }],
      total_written: 500
    }
  };

  const res = await gateway.syncInvoice(domain);
  assert.equal(res.success, true);
  assert.equal(res.documentNumber, 'MOCK-99');
  assert.equal(res.isMock, true);
  assert.equal(gateway.syncCalls.length, 1);
});

test('LiveIikoAccountingGateway splits mixed invoices and calls createInvoice sequentially', async () => {
  const calls: InvoiceData[] = [];
  const mockClient = {
    getProducts: async () => [
      { id: 'p1', name: 'Сыр', unit: 'кг' },
      { id: 'p2', name: 'Перчатки латексные', unit: 'уп' }
    ],
    createInvoice: async (data: InvoiceData) => {
      calls.push(data);
      const prefix = data.warehouse === 'household' ? 'HOUSE' : 'KITCHEN';
      return { success: true, documentNumber: `DOC-${prefix}-1` };
    }
  } as unknown as IikoClient;

  const gateway = new LiveIikoAccountingGateway({ client: mockClient });
  const domain: InvoiceDomainRecord = {
    invoice: {
      id: 5,
      date: '16.11.2026',
      supplier: 'ХозОвощи',
      warehouse: 'kitchen',
      total_calculated: 700,
      total_written: 700,
      status: 'pending',
      created_at: '2026-11-16 12:00:00'
    },
    items: [],
    data: {
      date: '16.11.2026',
      supplier: 'ХозОвощи',
      warehouse: 'kitchen',
      items: [
        { name: 'Сыр', qty: 1, price: 400, sum: 400, warehouse: 'kitchen' },
        { name: 'Перчатки латексные', qty: 1, price: 300, sum: 300, warehouse: 'household' }
      ],
      total_written: 700
    }
  };

  const res = await gateway.syncInvoice(domain);
  assert.equal(res.success, true);
  assert.equal(res.isSplit, true);
  assert.equal(res.documentNumbers?.kitchen, 'DOC-KITCHEN-1');
  assert.equal(res.documentNumbers?.household, 'DOC-HOUSE-1');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].warehouse, 'kitchen');
  assert.equal(calls[1].warehouse, 'household');
});

test('LiveIikoAccountingGateway handles partial split failure and preserves error metadata', async () => {
  const mockClient = {
    getProducts: async () => [
      { id: 'p1', name: 'Сыр', unit: 'кг' },
      { id: 'p2', name: 'Перчатки', unit: 'уп' }
    ],
    createInvoice: async (data: InvoiceData) => {
      if (data.warehouse === 'kitchen') {
        return { success: true, documentNumber: 'KITCHEN-OK-10' };
      }
      return {
        success: false,
        unmatched: ['Перчатки'],
        unitWarnings: ['Предупреждение по единицам упаковки'],
        message: 'Хоз склад временно закрыт на инвентаризацию'
      };
    }
  } as unknown as IikoClient;

  const gateway = new LiveIikoAccountingGateway({ client: mockClient });
  const domain: InvoiceDomainRecord = {
    invoice: {
      id: 6,
      date: '16.11.2026',
      supplier: 'Смешанный',
      warehouse: 'kitchen',
      total_calculated: 500,
      total_written: 500,
      status: 'pending',
      created_at: '2026-11-16 12:00:00'
    },
    items: [],
    data: {
      date: '16.11.2026',
      supplier: 'Смешанный',
      warehouse: 'kitchen',
      items: [
        { name: 'Сыр', qty: 1, price: 300, sum: 300, warehouse: 'kitchen' },
        { name: 'Перчатки', qty: 1, price: 200, sum: 200, warehouse: 'household' }
      ],
      total_written: 500
    }
  };

  const res = await gateway.syncInvoice(domain);
  assert.equal(res.success, false);
  assert.equal(res.isSplit, true);
  assert.equal(res.documentNumber, 'KITCHEN-OK-10');
  assert.deepEqual(res.unmatched, ['Перчатки']);
  assert.deepEqual(res.unitWarnings, ['Предупреждение по единицам упаковки']);
  assert.match(res.message || '', /Накладная «Кухня» успешно создана в iiko/);
});

test('MockIikoAccountingGateway splits mixed invoices and blocks unmatched nomenclature', async () => {
  const gateway = new MockIikoAccountingGateway([
    { id: 'p1', name: 'Помидоры', unit: 'кг' },
    { id: 'p2', name: 'Салфетки бумажные', unit: 'пач' }
  ]);

  const mixedDomain: InvoiceDomainRecord = {
    invoice: {
      id: 77,
      date: '16.11.2026',
      supplier: 'База',
      warehouse: 'kitchen',
      total_calculated: 600,
      total_written: 600,
      status: 'pending',
      created_at: '2026-11-16 12:00:00'
    },
    items: [],
    data: {
      date: '16.11.2026',
      supplier: 'База',
      warehouse: 'kitchen',
      items: [
        { name: 'Помидоры', qty: 2, price: 200, sum: 400, warehouse: 'kitchen' },
        { name: 'Салфетки бумажные', qty: 2, price: 100, sum: 200, warehouse: 'household' }
      ],
      total_written: 600
    }
  };

  // 1. Success split
  const res = await gateway.syncInvoice(mixedDomain);
  assert.equal(res.success, true);
  assert.equal(res.isSplit, true);
  assert.equal(res.documentNumbers?.kitchen, 'MOCK-KITCHEN-77');
  assert.equal(res.documentNumbers?.household, 'MOCK-HOUSEHOLD-77');

  // 2. Partial split failure simulation
  gateway.partialSplitFail = true;
  const resPartial = await gateway.syncInvoice(mixedDomain);
  assert.equal(resPartial.success, false);
  assert.equal(resPartial.isSplit, true);
  assert.equal(resPartial.documentNumber, 'MOCK-KITCHEN-77');
  gateway.partialSplitFail = false;

  // 3. Nomenclature blocking check
  const unmatchedDomain: InvoiceDomainRecord = {
    invoice: { ...mixedDomain.invoice, id: 78 },
    items: [],
    data: {
      ...mixedDomain.data,
      items: [
        { name: 'Неизвестный порошок xyz', qty: 1, price: 100, sum: 100, warehouse: 'kitchen' }
      ]
    }
  };
  const resUnmatched = await gateway.syncInvoice(unmatchedDomain);
  assert.equal(resUnmatched.success, false);
  assert.deepEqual(resUnmatched.unmatched, ['Неизвестный порошок xyz']);
});
