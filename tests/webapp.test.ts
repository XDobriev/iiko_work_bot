import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../src/db/database.js';
import { InvoicesRepository } from '../src/db/invoices.repo.js';
import { InvoiceWorkflow } from '../src/workflow/invoice-workflow.js';
import { startWebAppServer } from '../src/webapp/server.js';
import { InvoiceData } from '../src/types/index.js';

test('WebApp Server: end-to-end API, static serving, and CORS', async () => {
  // Use in-memory SQLite database initialized with full schema
  const memDb = getDatabase(':memory:');

  const repo = new InvoicesRepository(memDb);
  const workflow = new InvoiceWorkflow({ repo });

  // Create test invoice
  const initialData: InvoiceData = {
    date: '14.11.2026',
    supplier: 'ООО Мясокомбинат',
    warehouse: 'kitchen',
    items: [
      { name: 'Говядина вырезка', qty: 5, price: 900, sum: 4500, unit: 'кг' },
      { name: 'Телятина', qty: 3, price: 750, sum: 2250, unit: 'кг' }
    ],
    total_written: 6750
  };

  const { invoiceId } = repo.saveInvoice(initialData);

  // Start webapp on random free port with onInvoiceUpdated callback
  const TEST_PORT = 39485;
  let updatedInvoiceIdFromCallback: number | null = null;
  let callbackCardText: string | null = null;

  const webapp = startWebAppServer(workflow, TEST_PORT, {
    onInvoiceUpdated: (invId, cardText) => {
      updatedInvoiceIdFromCallback = invId;
      callbackCardText = cardText;
    }
  });

  try {
    const baseUrl = `http://localhost:${TEST_PORT}`;

    // 1. Health Check
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json() as { status: string };
    assert.equal(healthJson.status, 'ok');

    // 2. CORS Preflight
    const corsRes = await fetch(`${baseUrl}/api/invoice/${invoiceId}`, { method: 'OPTIONS' });
    assert.equal(corsRes.status, 204);
    assert.equal(corsRes.headers.get('access-control-allow-origin'), '*');

    // 3. Static WebApp HTML
    const htmlRes = await fetch(`${baseUrl}/webapp`);
    assert.equal(htmlRes.status, 200);
    const htmlText = await htmlRes.text();
    assert.ok(htmlText.includes('telegram-web-app.js'), 'HTML should contain telegram-web-app script');
    assert.ok(htmlText.includes('Редактор накладной'), 'HTML should contain editor title');
    assert.ok(htmlText.includes('disableVerticalSwipes'), 'HTML should configure disableVerticalSwipes');
    assert.ok(htmlText.includes('iiko-matcher-box'), 'HTML should contain iiko matcher UI box');

    // 4. GET /api/invoice/latest
    const latestRes = await fetch(`${baseUrl}/api/invoice/latest`);
    assert.equal(latestRes.status, 200);
    const latestJson = await latestRes.json() as { success: boolean; invoiceId: number; data: InvoiceData };
    assert.equal(latestJson.success, true);
    assert.equal(latestJson.invoiceId, invoiceId);

    // 5. GET /api/invoices/recent
    const recentRes = await fetch(`${baseUrl}/api/invoices/recent`);
    assert.equal(recentRes.status, 200);
    const recentJson = await recentRes.json() as { success: boolean; invoices: Array<{ id: number }> };
    assert.equal(recentJson.success, true);
    assert.ok(recentJson.invoices.some(inv => inv.id === invoiceId));

    // 6. GET /api/invoice/:id
    const invRes = await fetch(`${baseUrl}/api/invoice/${invoiceId}`);
    assert.equal(invRes.status, 200);
    const invJson = await invRes.json() as { success: boolean; data: InvoiceData; knownItems: string[]; recentInvoices: Array<{ id: number }> };
    assert.equal(invJson.success, true);
    assert.equal(invJson.data.supplier, 'ООО Мясокомбинат');
    assert.equal(invJson.data.items.length, 2);
    assert.ok(Array.isArray(invJson.recentInvoices));

    // 7. POST /api/invoice/:id (Edit via WebApp)
    const updatedData: InvoiceData = {
      date: '14.11.2026',
      supplier: 'ООО Мясокомбинат Люкс',
      warehouse: 'household',
      items: [
        { name: 'Говядина вырезка', qty: 6, price: 950, sum: 5700, unit: 'кг' },
        { name: 'Специи', qty: 2, price: 150, sum: 300, unit: 'уп' }
      ],
      total_written: 6000
    };

    const editRes = await fetch(`${baseUrl}/api/invoice/${invoiceId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: updatedData,
        mappings: [
          { rawName: 'Говядина вырезка', iikoProductName: 'Говядина (вырезка охл)', iikoProductId: 'iiko-gov-01' }
        ]
      })
    });

    assert.equal(editRes.status, 200);
    const editJson = await editRes.json() as { success: boolean; data: InvoiceData };
    assert.equal(editJson.success, true);
    assert.equal(editJson.data.warehouse, 'household');
    assert.equal(editJson.data.items.length, 2);

    // Verify onInvoiceUpdated callback was fired!
    assert.equal(updatedInvoiceIdFromCallback, invoiceId);
    assert.ok(callbackCardText && callbackCardText.includes('Хоз склад'));

    // Verify persisted in SQLite
    const verifyDomain = repo.getInvoice(invoiceId);
    assert.ok(verifyDomain);
    assert.equal(verifyDomain.data.supplier, 'ООО Мясокомбинат Люкс');
    assert.equal(verifyDomain.data.warehouse, 'household');
    assert.equal(verifyDomain.invoice.total_calculated, 6000);

    // Verify mapping was saved
    const mapping = repo.findProductMapping('Говядина вырезка');
    assert.ok(mapping);
    assert.equal(mapping.iikoProductName, 'Говядина (вырезка охл)');

    // 8. GET /api/products
    const prodRes = await fetch(`${baseUrl}/api/products`);
    assert.equal(prodRes.status, 200);
    const prodJson = await prodRes.json() as { success: boolean; mappings: Array<{ raw_name: string }> };
    assert.equal(prodJson.success, true);
    assert.ok(prodJson.mappings.some(m => m.raw_name === 'Говядина вырезка'));

    // 9. POST /api/mapping
    const mapRes = await fetch(`${baseUrl}/api/mapping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rawName: 'Кинза свежая',
        iikoProductName: 'Кинза зелень',
        iikoProductId: 'iiko-kinza-12'
      })
    });
    assert.equal(mapRes.status, 200);
    const verifyKinza = repo.findProductMapping('Кинза свежая');
    assert.ok(verifyKinza);
    assert.equal(verifyKinza.iikoProductName, 'Кинза зелень');
  } finally {
    await webapp.stop();
  }
});
