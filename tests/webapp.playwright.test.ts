import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium, Browser } from 'playwright';
import { getDatabase } from '../src/db/database.js';
import { InvoicesRepository } from '../src/db/invoices.repo.js';
import { InvoiceWorkflow } from '../src/workflow/invoice-workflow.js';
import { startWebAppServer, WebAppServerInstance } from '../src/webapp/server.js';
import { InvoiceData } from '../src/types/index.js';

const PLAYWRIGHT_TEST_DB = './data/test_playwright.db';

test('Playwright E2E: Telegram Mini App renders warehouse badges, edits items, and saves changes', async () => {
  // 1. Setup isolated database and workflow
  if (fs.existsSync(PLAYWRIGHT_TEST_DB)) {
    try { fs.unlinkSync(PLAYWRIGHT_TEST_DB); } catch {}
  }
  const db = getDatabase(PLAYWRIGHT_TEST_DB);
  const repo = new InvoicesRepository(db);
  const workflow = new InvoiceWorkflow({ repo });

  // 2. Pre-seed invoice with mixed warehouse items
  const initialInvoice: InvoiceData = {
    date: '15.11.2026',
    supplier: 'Фермерское Хозяйство',
    warehouse: 'kitchen',
    items: [
      { name: 'Говядина шея', qty: 10, price: 600, sum: 6000, unit: 'кг', warehouse: 'kitchen' },
      { name: 'Перчатки нитриловые', qty: 2, price: 300, sum: 600, unit: 'уп', warehouse: 'household' }
    ],
    total_written: 6600
  };

  const { invoiceId } = repo.saveInvoice(initialInvoice);
  assert.ok(invoiceId > 0, 'Seed invoice created');

  // 3. Start local WebApp server on dedicated test port
  const testPort = 3847;
  const webAppInstance: WebAppServerInstance = startWebAppServer(workflow, testPort);

  // 4. Launch headless browser via Playwright
  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
  } catch {
    browser = await chromium.launch({ headless: true });
  }

  const page = await browser.newPage();

  try {
    // 5. Navigate to WebApp editor for the invoice
    const targetUrl = `http://127.0.0.1:${testPort}/?invoiceId=${invoiceId}`;
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

    // Wait for the invoice title and items to appear
    await page.waitForSelector('#items-list .item-card');

    // 6. Verify initial rendering
    const supplierValue = await page.$eval('#supplier-input', (el: any) => el.value);
    assert.strictEqual(supplierValue, 'Фермерское Хозяйство');

    const cardsCount = await page.$$eval('.item-card', cards => cards.length);
    assert.strictEqual(cardsCount, 2, 'Must display exactly 2 item cards');

    // Check warehouse badges
    const badge0Text = await page.$eval('#item-wh-btn-0', (el: any) => el.innerText.trim());
    const badge1Text = await page.$eval('#item-wh-btn-1', (el: any) => el.innerText.trim());
    assert.match(badge0Text, /Кухня/);
    assert.match(badge1Text, /Хоз/);

    // Check warehouse breakdown displays mixed sums
    await page.waitForSelector('#warehouse-breakdown');
    const breakdownText = await page.$eval('#warehouse-breakdown', (el: any) => el.innerText);
    assert.match(breakdownText, /Кухня/);
    assert.match(breakdownText, /Хоз/);

    // 7. Perform user edits in UI
    // a) Change supplier
    await page.fill('#supplier-input', 'ООО АгроАльянс Юг');

    // b) Change item 1 price
    const priceInput0 = (await page.$$('.item-card .price-input'))[0];
    await priceInput0.fill('650');

    // c) Increment item 1 quantity via stepper '+'
    const stepperBtnPlus = (await page.$$('.item-card .stepper-btn'))[1]; // second button is '+' of card 0
    await stepperBtnPlus.click();

    // d) Toggle item 1 warehouse badge from Kitchen to Household
    await page.click('#item-wh-btn-0');
    const updatedBadge0 = await page.$eval('#item-wh-btn-0', (el: any) => el.innerText.trim());
    assert.match(updatedBadge0, /Хоз/, 'Item 1 warehouse badge must switch to Household');

    // 8. Save invoice via save button
    await page.click('.btn-save-main');

    // Wait for toast notification
    await page.waitForSelector('#toast.show', { timeout: 4000 });
    const toastText = await page.$eval('#toast-text', (el: any) => el.innerText);
    assert.match(toastText, /Сохранено|обновлена/i);

    // 9. Verify in SQLite Database
    const updatedDomain = repo.getInvoice(invoiceId);
    assert.ok(updatedDomain, 'Updated invoice must exist in database');
    assert.strictEqual(updatedDomain.data.supplier, 'ООО АгроАльянс Юг');
    assert.strictEqual(updatedDomain.data.items[0].qty, 11, 'Quantity incremented by stepper');
    assert.strictEqual(updatedDomain.data.items[0].price, 650, 'Price updated to 650');
    assert.strictEqual(updatedDomain.data.items[0].sum, 7150, 'Sum recalculated (11 * 650)');
    assert.strictEqual(updatedDomain.data.items[0].warehouse, 'household', 'Item 1 warehouse changed to household');
  } finally {
    await browser.close();
    await webAppInstance.stop();
    if (fs.existsSync(PLAYWRIGHT_TEST_DB)) {
      try { fs.unlinkSync(PLAYWRIGHT_TEST_DB); } catch {}
    }
  }
});
