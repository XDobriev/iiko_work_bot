import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getDatabase } from '../src/db/database.js';
import { InvoicesRepository, normalizeName } from '../src/db/invoices.repo.js';
import { InvoiceData } from '../src/types/index.js';

const TEST_DB_PATH = './data/test_unit_repo.db';

function setupRepo(): InvoicesRepository {
  if (fs.existsSync(TEST_DB_PATH)) {
    try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  }
  const db = getDatabase(TEST_DB_PATH);
  return new InvoicesRepository(db);
}

test('normalizeName cleans punctuation, case and whitespace', () => {
  assert.strictEqual(normalizeName('  «Говядина» (мякоть), 1 кат.!  '), 'говядина мякоть 1 кат');
  assert.strictEqual(normalizeName('Сыр "Сулугуни" 45%'), 'сыр сулугуни 45%');
  assert.strictEqual(normalizeName('Свёкла свежая'), 'свекла свежая');
});

test('InvoicesRepository saves and retrieves typed domain record', () => {
  const repo = setupRepo();

  const invoiceData: InvoiceData = {
    date: '10.11.2026',
    supplier: 'Мясной Мир',
    warehouse: 'kitchen',
    items: [
      { name: 'Говядина мякоть', qty: 10, price: 650, sum: 6500, unit: 'кг' },
      { name: 'Баранина', qty: 5, price: 700, sum: 3500, unit: 'кг' }
    ],
    total_written: 10000
  };

  const { invoiceId, totalCalculated } = repo.saveInvoice(invoiceData, { userId: 12345 });
  assert.ok(invoiceId > 0);
  assert.strictEqual(totalCalculated, 10000);

  // Retrieve typed domain model
  const domain = repo.getInvoice(invoiceId);
  assert.ok(domain);
  assert.strictEqual(domain.data.supplier, 'Мясной Мир');
  assert.strictEqual(domain.data.date, '10.11.2026');
  assert.strictEqual(domain.data.warehouse, 'kitchen');
  assert.strictEqual(domain.data.items.length, 2);
  assert.strictEqual(domain.data.items[0].name, 'Говядина мякоть');
  assert.strictEqual(domain.data.items[0].qty, 10);
  assert.strictEqual(domain.data.items[0].price, 650);
  assert.strictEqual(domain.data.items[0].unit, 'кг');
  assert.strictEqual(domain.invoice.id, invoiceId);
  assert.strictEqual(domain.invoice.total_calculated, 10000);
});

test('InvoicesRepository enhanced duplicate detection handles identical vs distinct same-day deliveries', () => {
  const repo = setupRepo();

  const invoice1: InvoiceData = {
    date: '15.11.2026',
    supplier: 'Овощной Рай',
    warehouse: 'kitchen',
    items: [
      { name: 'Картофель', qty: 100, price: 35, sum: 3500, unit: 'кг' },
      { name: 'Морковь', qty: 30, price: 40, sum: 1200, unit: 'кг' }
    ],
    total_written: 4700
  };
  repo.saveInvoice(invoice1);

  // 1. Same supplier, same date, identical total and composition -> DUPLICATE!
  const dupCheck1 = repo.checkDuplicate(invoice1);
  assert.strictEqual(dupCheck1.isDuplicate, true);

  // 2. Same supplier, same date, but completely different delivery (e.g. evening greens order, 800 руб) -> NOT A DUPLICATE!
  const eveningInvoice: InvoiceData = {
    date: '15.11.2026',
    supplier: 'Овощной Рай',
    warehouse: 'kitchen',
    items: [
      { name: 'Укроп свежий', qty: 5, price: 100, sum: 500, unit: 'уп' },
      { name: 'Петрушка', qty: 3, price: 100, sum: 300, unit: 'уп' }
    ],
    total_written: 800
  };
  const dupCheck2 = repo.checkDuplicate(eveningInvoice);
  assert.strictEqual(dupCheck2.isDuplicate, false);

  // 3. Re-upload of same invoice with same total and matching items -> DUPLICATE!
  const reuploadWithMissingDate: InvoiceData = {
    date: '16.11.2026',
    supplier: 'Овощной Рай',
    warehouse: 'kitchen',
    items: [
      { name: 'Картофель', qty: 100, price: 35, sum: 3500, unit: 'кг' },
      { name: 'Морковь', qty: 30, price: 40, sum: 1200, unit: 'кг' }
    ],
    total_written: 4700
  };
  const dupCheck3 = repo.checkDuplicate(reuploadWithMissingDate);
  assert.strictEqual(dupCheck3.isDuplicate, true);

  // 4. Same supplier, same date, SAME TOTAL (4700 руб), but completely different items (e.g. Tomatoes + Cucumbers) -> NOT A DUPLICATE!
  const sameTotalDifferentItems: InvoiceData = {
    date: '15.11.2026',
    supplier: 'Овощной Рай',
    warehouse: 'kitchen',
    items: [
      { name: 'Томаты черри', qty: 20, price: 200, sum: 4000, unit: 'кг' },
      { name: 'Огурцы гладкие', qty: 7, price: 100, sum: 700, unit: 'кг' }
    ],
    total_written: 4700
  };
  const dupCheck4 = repo.checkDuplicate(sameTotalDifferentItems);
  assert.strictEqual(dupCheck4.isDuplicate, false, 'Same total with completely different items must not be flagged as duplicate');

  // 5. Cyrillic case insensitivity: 'овощной рай' vs 'Овощной Рай'
  const lowercaseSupplierInvoice: InvoiceData = {
    date: '15.11.2026',
    supplier: '«овощной рай»',
    warehouse: 'kitchen',
    items: [
      { name: 'Картофель', qty: 100, price: 35, sum: 3500, unit: 'кг' },
      { name: 'Морковь', qty: 30, price: 40, sum: 1200, unit: 'кг' }
    ],
    total_written: 4700
  };
  const dupCheck5 = repo.checkDuplicate(lowercaseSupplierInvoice);
  assert.strictEqual(dupCheck5.isDuplicate, true, 'Different casing of supplier name must still detect duplicate');
});

test('InvoicesRepository persists and retrieves product mappings', () => {
  const repo = setupRepo();

  // Save mapping
  repo.saveProductMapping('говядина', 'Говядина б/к мякоть охл', 'guid-beef-123');

  // Find mapping
  const found = repo.findProductMapping('Говядина');
  assert.ok(found);
  assert.strictEqual(found.iikoProductName, 'Говядина б/к мякоть охл');
  assert.strictEqual(found.iikoProductId, 'guid-beef-123');

  // List all mappings
  const all = repo.getAllProductMappings();
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].raw_name, 'говядина');

  // Update existing mapping (UPSERT)
  repo.saveProductMapping('говядина', 'Говядина вырезка охл', 'guid-beef-456');
  const updated = repo.findProductMapping('говядина');
  assert.strictEqual(updated?.iikoProductName, 'Говядина вырезка охл');
  assert.strictEqual(updated?.iikoProductId, 'guid-beef-456');

  // Delete mapping
  const deleted = repo.deleteProductMapping('говядина');
  assert.strictEqual(deleted, true);
  assert.strictEqual(repo.findProductMapping('говядина'), null);
});

test('InvoicesRepository detects price trends, anomalies, and packaging changes', () => {
  const repo = setupRepo();

  // Past invoice #1
  repo.saveInvoice({
    date: '01.11.2026',
    supplier: 'Ферма',
    warehouse: 'kitchen',
    items: [
      { name: 'Молоко 3.2%', qty: 20, price: 80, sum: 1600, unit: 'л' },
      { name: 'Сыр Гауда', qty: 10, price: 600, sum: 6000, unit: 'кг' },
      { name: 'Оливки', qty: 5, price: 150, sum: 750, unit: 'бан' }
    ]
  });

  // New invoice
  const comp = repo.compareWithHistory({
    date: '08.11.2026',
    supplier: 'Ферма',
    warehouse: 'kitchen',
    items: [
      // 1. Price increase: 80 -> 90 (+10 / +12.5%)
      { name: 'Молоко 3.2%', qty: 20, price: 90, sum: 1800, unit: 'л' },
      // 2. Price anti-shock anomaly: 600 -> 1200 (+100%)
      { name: 'Сыр Гауда', qty: 5, price: 1200, sum: 6000, unit: 'кг' },
      // 3. Packaging unit change: was 'бан', now 'кг'
      { name: 'Оливки', qty: 2, price: 150, sum: 300, unit: 'кг' },
      // 4. Brand new item
      { name: 'Масло сливочное', qty: 4, price: 250, sum: 1000, unit: 'уп' }
    ],
    total_written: 9100
  });

  // Check milk
  const milkComp = comp.priceComparisons.find(c => c.name === 'Молоко 3.2%');
  assert.ok(milkComp);
  assert.strictEqual(milkComp.trend, 'up');
  assert.strictEqual(milkComp.deltaRub, 10);
  assert.strictEqual(milkComp.deltaPercent, 12.5);
  assert.strictEqual(milkComp.isAnomaly, false);

  // Check cheese: anomaly > 70%
  const cheeseComp = comp.priceComparisons.find(c => c.name === 'Сыр Гауда');
  assert.ok(cheeseComp);
  assert.strictEqual(cheeseComp.isAnomaly, true);
  assert.match(cheeseComp.anomalyMessage || '', /Аномальное изменение цены/);

  // Check olives: packaging change
  const olivesComp = comp.priceComparisons.find(c => c.name === 'Оливки');
  assert.ok(olivesComp);
  assert.strictEqual(olivesComp.isAnomaly, true);
  assert.match(olivesComp.anomalyMessage || '', /Изменилась единица измерения/);

  // Check butter: new
  const butterComp = comp.priceComparisons.find(c => c.name === 'Масло сливочное');
  assert.ok(butterComp);
  assert.strictEqual(butterComp.trend, 'new');
});

test('InvoicesRepository persists and manages bot edit sessions', () => {
  const repo = setupRepo();

  // Initially no session
  assert.strictEqual(repo.getEditSession(999), null);

  // Save session
  repo.saveEditSession(999, {
    invoiceId: 10,
    cardMessageId: 200,
    chatId: -10012345,
    editPromptMessageId: 201
  });

  const session = repo.getEditSession(999);
  assert.ok(session);
  assert.strictEqual(session.invoiceId, 10);
  assert.strictEqual(session.cardMessageId, 200);
  assert.strictEqual(session.chatId, -10012345);
  assert.strictEqual(session.editPromptMessageId, 201);

  // Update session
  repo.saveEditSession(999, {
    invoiceId: 11,
    cardMessageId: 300,
    chatId: -10012345
  });
  const updated = repo.getEditSession(999);
  assert.strictEqual(updated?.invoiceId, 11);
  assert.strictEqual(updated?.cardMessageId, 300);

  // Delete session
  const deleted = repo.deleteEditSession(999);
  assert.strictEqual(deleted, true);
  assert.strictEqual(repo.getEditSession(999), null);
});
