import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../src/db/database.js';
import { InvoicesRepository } from '../src/db/invoices.repo.js';
import { InvoiceWorkflow } from '../src/workflow/invoice-workflow.js';
import { startWebAppServer } from '../src/webapp/server.js';
import { InvoiceData } from '../src/types/index.js';

test('WebApp Server: end-to-end API, static serving, and CORS', async () => {
  // Use in-memory SQLite database for pure isolated testing
  const memDb = new DatabaseSync(':memory:');
  memDb.exec(`
    CREATE TABLE invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id TEXT DEFAULT 'beyni',
      date TEXT,
      supplier TEXT,
      warehouse TEXT DEFAULT 'kitchen',
      total_calculated REAL NOT NULL DEFAULT 0,
      total_written REAL,
      status TEXT NOT NULL DEFAULT 'pending',
      iiko_document_id TEXT,
      telegram_user_id INTEGER,
      telegram_message_id INTEGER,
      photo_file_id TEXT,
      local_photo_path TEXT,
      raw_json TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      qty REAL NOT NULL DEFAULT 0,
      price REAL NOT NULL DEFAULT 0,
      sum REAL NOT NULL DEFAULT 0,
      unit TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE product_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_name TEXT NOT NULL UNIQUE,
      normalized_name TEXT NOT NULL,
      iiko_product_name TEXT NOT NULL,
      iiko_product_id TEXT,
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
  `);

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

  // Start webapp on random free port
  const TEST_PORT = 39485;
  const webapp = startWebAppServer(workflow, TEST_PORT);

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

    // 4. GET /api/invoice/:id
    const invRes = await fetch(`${baseUrl}/api/invoice/${invoiceId}`);
    assert.equal(invRes.status, 200);
    const invJson = await invRes.json() as { success: boolean; data: InvoiceData; knownItems: string[] };
    assert.equal(invJson.success, true);
    assert.equal(invJson.data.supplier, 'ООО Мясокомбинат');
    assert.equal(invJson.data.items.length, 2);

    // 5. POST /api/invoice/:id (Edit via WebApp)
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

    // 6. GET /api/products
    const prodRes = await fetch(`${baseUrl}/api/products`);
    assert.equal(prodRes.status, 200);
    const prodJson = await prodRes.json() as { success: boolean; mappings: Array<{ raw_name: string }> };
    assert.equal(prodJson.success, true);
    assert.ok(prodJson.mappings.some(m => m.raw_name === 'Говядина вырезка'));

    // 7. POST /api/mapping
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
