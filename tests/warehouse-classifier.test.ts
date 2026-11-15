import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyItemWarehouse,
  classifyInvoiceItems,
  partitionItemsByWarehouse,
  isHouseholdItemName
} from '../src/workflow/warehouse-classifier.js';
import { formatInvoiceMessage } from '../src/bot/formatter.js';
import { InvoiceData, HistoricalComparison } from '../src/types/index.js';

test('warehouse-classifier detects household keywords by Russian roots', () => {
  const householdItems = [
    'Перчатки нитриловые черные L',
    'перчатка х/б',
    'Салфетки бумажные 100шт',
    'Моющее средство для посуды Fairy',
    'Моющий гель',
    'Губка металлическая',
    'Губки поролоновые',
    'Пакеты для мусора 120л',
    'Пакет майка',
    'Тряпка из микрофибры',
    'Тряпки для пола',
    'Уголь древесный березовый 10кг',
    'Дезсредство Ника',
    'Дезинфектор для рук',
    'Фольга пищевая 45см',
    'Контейнер полипропиленовый с крышкой',
    'Мыло жидкое антибактериальное',
    'Белизна 1л',
    'Пленка стретч 500мм',
    'Плёнка пищевая'
  ];

  for (const name of householdItems) {
    assert.strictEqual(
      isHouseholdItemName(name),
      true,
      `Expected "${name}" to be detected as household`
    );
    assert.strictEqual(
      classifyItemWarehouse(name),
      'household',
      `Expected classifyItemWarehouse("${name}") to be "household"`
    );
  }
});

test('warehouse-classifier detects kitchen food and ingredients', () => {
  const kitchenItems = [
    'Говядина шея охл',
    'Помидоры бакинские',
    'Сыр сулугуни',
    'Мука пшеничная в/с',
    'Молоко 3.2% 1л',
    'Масло подсолнечное рафинированное',
    'Лук репчатый',
    'Кинза свежая',
    'Петрушка',
    'Томатная паста Помидорка',
    'Сахар песок',
    'Соль поваренная'
  ];

  for (const name of kitchenItems) {
    assert.strictEqual(
      isHouseholdItemName(name),
      false,
      `Expected "${name}" NOT to be detected as household`
    );
    assert.strictEqual(
      classifyItemWarehouse(name),
      'kitchen',
      `Expected classifyItemWarehouse("${name}") to default to "kitchen"`
    );
  }
});

test('classifyInvoiceItems enriches items without explicit warehouse', () => {
  const items = [
    { name: 'Помидоры', qty: 5, price: 200, sum: 1000 },
    { name: 'Перчатки нитриловые', qty: 2, price: 350, sum: 700 }
  ];

  const classified = classifyInvoiceItems(items, 'kitchen');
  assert.strictEqual(classified[0].warehouse, 'kitchen');
  assert.strictEqual(classified[1].warehouse, 'household');
});

test('partitionItemsByWarehouse separates kitchen and household items', () => {
  const mixed = [
    { name: 'Мясо говядина', qty: 10, price: 600, sum: 6000, warehouse: 'kitchen' as const },
    { name: 'Перчатки', qty: 2, price: 300, sum: 600, warehouse: 'household' as const },
    { name: 'Салфетки', qty: 5, price: 50, sum: 250, warehouse: 'household' as const },
    { name: 'Сыр', qty: 1, price: 400, sum: 400, warehouse: 'kitchen' as const }
  ];

  const { kitchen, household, isMixed } = partitionItemsByWarehouse(mixed);
  assert.strictEqual(isMixed, true);
  assert.strictEqual(kitchen.length, 2);
  assert.strictEqual(household.length, 2);
  assert.strictEqual(kitchen[0].name, 'Мясо говядина');
  assert.strictEqual(kitchen[1].name, 'Сыр');
  assert.strictEqual(household[0].name, 'Перчатки');
  assert.strictEqual(household[1].name, 'Салфетки');
});

test('formatInvoiceMessage groups mixed invoices into Kitchen and Household blocks with subtotals', () => {
  const data: InvoiceData = {
    date: '15.11.2026',
    supplier: 'УниверсалТорг',
    warehouse: 'kitchen',
    items: [
      { name: 'Говядина вырезка', qty: 10, price: 600, sum: 6000, unit: 'кг', warehouse: 'kitchen' },
      { name: 'Помидоры', qty: 5, price: 200, sum: 1000, unit: 'кг', warehouse: 'kitchen' },
      { name: 'Перчатки нитрил', qty: 2, price: 350, sum: 700, unit: 'уп', warehouse: 'household' },
      { name: 'Салфетки барные', qty: 10, price: 50, sum: 500, unit: 'уп', warehouse: 'household' }
    ],
    total_written: 8200
  };

  const comparison: HistoricalComparison = {
    isDuplicate: false,
    priceComparisons: [],
    totalPriceDelta: 0,
    mathDiscrepancy: false,
    discrepancyDiff: 0
  };

  const card = formatInvoiceMessage(105, data, comparison);

  // Checks header indicates mixed warehouse
  assert.match(card, /Склад:.*Кухня.*Хоз склад/i);

  // Checks both blocks are present with subtotals
  assert.match(card, /🍽 Склад Кухня \(продукты\):/);
  assert.match(card, /Подытог Кухня:\s*7000/);

  assert.match(card, /🏠 Хоз склад \(хозтовары\):/);
  assert.match(card, /Подытог Хоз склад:\s*1200/);

  // Checks overall total
  assert.match(card, /ОБЩИЙ ИТОГ:\s*8200/);
});

test('classifyItemWarehouse honors explicit warehouse overrides', () => {
  // If user explicitly set item to kitchen, keyword shouldn't override user's decision
  assert.strictEqual(
    classifyItemWarehouse('Перчатки хозяйственные', 'kitchen'),
    'kitchen',
    'Explicit warehouse must take priority over name keywords'
  );
  assert.strictEqual(
    classifyItemWarehouse('Мясо говядина', 'household'),
    'household',
    'Explicit household must be respected'
  );
});

