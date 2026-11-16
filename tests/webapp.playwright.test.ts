import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium, Browser } from 'playwright';
import { getDatabase } from '../src/db/database.js';
import { InvoicesRepository } from '../src/db/invoices.repo.js';
import { InvoiceWorkflow } from '../src/workflow/invoice-workflow.js';
import { startWebAppServer, WebAppServerInstance } from '../src/webapp/server.js';
import { InvoiceData } from '../src/types/index.js';

test('Playwright E2E: Telegram Mini App renders warehouse badges, edits items, and saves changes', async () => {
  // 1. Setup isolated database and workflow
  const db = getDatabase(':memory:');
  const repo = new InvoicesRepository(db);
  const mockIikoClient: any = {
    isConfigured: () => false,
    getProducts: async () => [
      { id: 'beef-1', name: 'Говядина шея', unit: 'кг' },
      { id: 'gloves-1', name: 'Перчатки нитриловые', unit: 'уп' }
    ]
  };
  const workflow = new InvoiceWorkflow({ repo, iikoClient: mockIikoClient });

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
  }
});

test('Playwright E2E: Telegram Mini App interactive nomenclature matching, chips selection, live search, and send blocking', async () => {
  const db = getDatabase(':memory:');
  const repo = new InvoicesRepository(db);

  const mockCatalog = [
    { id: 'prod-beef-tenderloin', name: 'Говядина вырезка б/к охл', unit: 'кг' },
    { id: 'prod-suluguni', name: 'Сыр Сулугуни весовой', unit: 'кг' },
    { id: 'prod-gauda', name: 'Сыр Гауда 45% брусок', unit: 'кг' },
    { id: 'prod-gloves', name: 'Перчатки нитриловые M синие', unit: 'уп' }
  ];

  const mockIikoClient: any = {
    isConfigured: () => true,
    getProducts: async () => mockCatalog,
    createInvoice: async (data: InvoiceData) => ({
      success: true,
      documentNumber: 'DOC-IIKO-OK-1'
    })
  };

  const workflow = new InvoiceWorkflow({ repo, iikoClient: mockIikoClient });

  // Pre-seed invoice with 3 items:
  // Item 0: "Говядина вырезка" -> exact/high confidence match (🟢 matched)
  // Item 1: "Сыр" -> ambiguous match with suggestions (🟡 needs_selection with chips)
  // Item 2: "НеведомыйПорошокXYZ" -> unknown (🔴 not_found)
  const initialInvoice: InvoiceData = {
    date: '15.11.2026',
    supplier: 'ГлавСнаб Ресторан',
    warehouse: 'kitchen',
    items: [
      { name: 'Говядина вырезка', qty: 5, price: 900, sum: 4500, unit: 'кг', warehouse: 'kitchen' },
      { name: 'Сыр', qty: 2, price: 500, sum: 1000, unit: 'кг', warehouse: 'kitchen' },
      { name: 'НеведомыйПорошокXYZ', qty: 1, price: 200, sum: 200, unit: 'уп', warehouse: 'household' }
    ],
    total_written: 5700
  };

  const { invoiceId } = repo.saveInvoice(initialInvoice);
  assert.ok(invoiceId > 0, 'Seed invoice created');

  // Verify Requirement 4: confirmAndSync MUST BE BLOCKED before items are matched
  const blockedSync = await workflow.confirmAndSync(invoiceId);
  assert.strictEqual(blockedSync.success, false, 'Sync must be blocked when unmatched items exist');
  assert.ok(blockedSync.unmatched && blockedSync.unmatched.length > 0, 'Must report unmatched items');
  assert.match(blockedSync.message || '', /заблокировано/i, 'Message must clearly state sending is blocked');

  // Verify Requirement 4 on ambiguous-only invoice: an invoice with ONLY ambiguous items (🟡 needs_selection) must ALSO be blocked
  const ambiguousOnlyInvoice: InvoiceData = {
    date: '15.11.2026',
    supplier: 'ГлавСнаб Ресторан',
    warehouse: 'kitchen',
    items: [
      { name: 'Сыр', qty: 2, price: 500, sum: 1000, unit: 'кг', warehouse: 'kitchen' }
    ]
  };
  const { invoiceId: ambInvoiceId } = repo.saveInvoice(ambiguousOnlyInvoice);
  const ambBlockedSync = await workflow.confirmAndSync(ambInvoiceId);
  assert.strictEqual(ambBlockedSync.success, false, 'Sync must be blocked for ambiguous items requiring selection');
  assert.ok(ambBlockedSync.unmatched?.includes('Сыр'), 'Ambiguous "Сыр" must be flagged as unmatched');

  // Start webapp server on port 3849 (distinct from test 1 to prevent TIME_WAIT collision)
  const testPort = 3849;
  const webAppInstance: WebAppServerInstance = startWebAppServer(workflow, testPort);

  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
  } catch {
    browser = await chromium.launch({ headless: true });
  }

  const page = await browser.newPage();
  const pageErrors: Error[] = [];
  page.on('pageerror', err => pageErrors.push(err));

  try {
    const targetUrl = `http://127.0.0.1:${testPort}/?invoiceId=${invoiceId}`;
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#items-list .item-card');

    // 1. Verify item 0 has green matched status (🟢)
    const badge0 = await page.waitForSelector('#iiko-badge-0');
    const badge0Class = await badge0.getAttribute('class');
    const badge0Text = await badge0.innerText();
    assert.match(badge0Class || '', /matched/);
    assert.match(badge0Text, /🟢/);

    // 2. Verify item 1 has yellow needs-selection status (🟡) and top-3 suggestions chips
    const badge1 = await page.waitForSelector('#iiko-badge-1');
    const badge1Class = await badge1.getAttribute('class');
    const badge1Text = await badge1.innerText();
    assert.match(badge1Class || '', /needs-selection/);
    assert.match(badge1Text, /🟡/);

    // Check suggestion chips are visible on card 1
    await page.waitForSelector('#item-card-1 .suggestion-chips-row');
    const chipButtons = await page.$$('#item-card-1 .chip-suggestion-btn');
    assert.ok(chipButtons.length >= 1, 'Item 1 must display quick suggestion chips');
    const chip1Text = await chipButtons[0].innerText();
    assert.match(chip1Text, /Сулугуни|Гауда/);

    // 3. Verify item 2 has red not-found status (🔴)
    const badge2 = await page.waitForSelector('#iiko-badge-2');
    const badge2Class = await badge2.getAttribute('class');
    const badge2Text = await badge2.innerText();
    assert.match(badge2Class || '', /not-found/);
    assert.match(badge2Text, /🔴/);

    // 4. Verify summary card displays warning about unmatched positions
    await page.waitForSelector('#unmatched-warning-container .unmatched-warning-box');
    const warnText = await page.$eval('#unmatched-warning-container', (el: any) => el.innerText);
    assert.match(warnText, /Несопоставленных позиций/);

    // 5. User interaction: Click suggestion chip on item 1 (Select "Сыр Сулугуни весовой")
    await chipButtons[0].click();

    // Verify item 1 status changes to 🟢 matched
    await page.waitForSelector('#iiko-badge-1.matched');
    const updatedBadge1Text = await page.$eval('#iiko-badge-1', (el: any) => el.innerText);
    assert.match(updatedBadge1Text, /🟢/);

    // Uncheck mapping checkbox on item 1 to verify user preference: DO NOT save mapping to product_mappings
    const toggleBtn1 = (await page.$$('#item-card-1 .btn-toggle-mapping'))[0];
    await toggleBtn1.click();
    await page.waitForSelector('#mapping-editor-1.open');
    const checkbox1 = await page.waitForSelector('#mapping-editor-1 .mapping-checkbox');
    await checkbox1.uncheck();

    // Test editing item name in item-name-input (ensure NO findBestIikoMatch ReferenceError!)
    const itemNameInput2 = await page.waitForSelector('#item-card-2 .item-name-input');
    await itemNameInput2.fill('Перчатки нитриловые');

    // 6. User interaction: Live search / dropdown selection on item 2 with letter-by-letter typing
    // Open mapping editor on item 2
    const toggleBtn2 = (await page.$$('#item-card-2 .btn-toggle-mapping'))[0];
    await toggleBtn2.click();

    // Mapping input becomes open
    await page.waitForSelector('#mapping-editor-2.open');
    const mappingInput2 = await page.waitForSelector('#mapping-editor-2 .mapping-input');
    await mappingInput2.click();

    // Clear and type letter-by-letter to verify focus and caret persistence
    await mappingInput2.fill('');
    await mappingInput2.type('Перчатки нитриловые M синие', { delay: 15 });

    // Verify input remained focused throughout typing
    const isFocused = await page.$eval('#mapping-editor-2 .mapping-input', el => document.activeElement === el);
    assert.strictEqual(isFocused, true, 'Mapping input must retain focus during letter-by-letter typing');

    // Verify item 2 status becomes 🟢 matched
    await page.waitForSelector('#iiko-badge-2.matched');
    const updatedBadge2Text = await page.$eval('#iiko-badge-2', (el: any) => el.innerText);
    assert.match(updatedBadge2Text, /🟢/);
    assert.match(updatedBadge2Text, /Перчатки нитриловые M/);

    // 7. Verify unmatched warning in summary card is now gone!
    const unmatchedWarnContent = await page.$eval('#unmatched-warning-container', (el: any) => el.innerHTML.trim());
    assert.strictEqual(unmatchedWarnContent, '', 'Unmatched warning must disappear when all items are mapped');

    // 8. Save invoice via save button
    await page.click('.btn-save-main');
    await page.waitForSelector('#toast.show', { timeout: 4000 });

    // 9. Verify in database:
    // Item 1 had checkbox UNCHECKED -> must NOT be in product_mappings
    const mappingCheese = repo.findProductMapping('Сыр');
    assert.strictEqual(mappingCheese, null, 'Unchecked mapping for "Сыр" must NOT be saved to product_mappings');

    // Item 2 had checkbox CHECKED -> MUST be in product_mappings with product ID
    const mappingGloves = repo.findProductMapping('Перчатки нитриловые');
    assert.ok(mappingGloves, 'Checked mapping for "Перчатки нитриловые" must be saved to product_mappings');
    assert.strictEqual(mappingGloves.iikoProductName, 'Перчатки нитриловые M синие');
    assert.strictEqual(mappingGloves.iikoProductId, 'prod-gloves');

    // 10. Requirement 4 Unblocked: Now confirmAndSync must succeed!
    const allowedSync = await workflow.confirmAndSync(invoiceId);
    assert.strictEqual(allowedSync.success, true, 'Sync must succeed once all items are mapped');

    // 11. Assert NO JavaScript runtime errors occurred in the browser
    assert.strictEqual(pageErrors.length, 0, `Browser encountered runtime errors: ${pageErrors.map(e => e.message).join('; ')}`);
  } finally {
    await browser.close();
    await webAppInstance.stop();
  }
});
