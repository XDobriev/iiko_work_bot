import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateMath,
  parseQuantityAndUnit,
  parseInvoiceEditText,
  formatEditableInvoice
} from '../src/bot/parser.js';
import { InvoiceData } from '../src/types/index.js';

test('evaluateMath evaluates valid expressions safely', () => {
  assert.strictEqual(evaluateMath('4*6.5'), 26);
  assert.strictEqual(evaluateMath('100 / 4'), 25);
  assert.strictEqual(evaluateMath('10 + 2.5'), 12.5);
  assert.strictEqual(evaluateMath('10,5 * 2'), 21);
  assert.strictEqual(evaluateMath('3 * (2 + 1.5)'), 10.5);
});

test('evaluateMath rejects malicious or malformed expressions', () => {
  assert.strictEqual(evaluateMath('process.exit(1)'), null);
  assert.strictEqual(evaluateMath('console.log(1)'), null);
  assert.strictEqual(evaluateMath(''), null);
  assert.strictEqual(evaluateMath('4*'), null);
  assert.strictEqual(evaluateMath('++--'), null);
});

test('parseQuantityAndUnit handles grams, kg, cans, packs, and plain numbers', () => {
  // Grams auto-converted to kg
  assert.deepStrictEqual(parseQuantityAndUnit('380г'), { qty: 0.38, unit: 'кг' });
  assert.deepStrictEqual(parseQuantityAndUnit('380гр'), { qty: 0.38, unit: 'кг' });
  assert.deepStrictEqual(parseQuantityAndUnit('4*250г'), { qty: 1, unit: 'кг' });

  // Kilograms with formulas
  assert.deepStrictEqual(parseQuantityAndUnit('15кг'), { qty: 15, unit: 'кг' });
  assert.deepStrictEqual(parseQuantityAndUnit('4*6.5кг'), { qty: 26, unit: 'кг' });

  // Other units
  assert.deepStrictEqual(parseQuantityAndUnit('2бан'), { qty: 2, unit: 'бан' });
  assert.deepStrictEqual(parseQuantityAndUnit('5уп'), { qty: 5, unit: 'уп' });
  assert.deepStrictEqual(parseQuantityAndUnit('10шт'), { qty: 10, unit: 'шт' });
  assert.deepStrictEqual(parseQuantityAndUnit('3бут'), { qty: 3, unit: 'бут' });
  assert.deepStrictEqual(parseQuantityAndUnit('20л'), { qty: 20, unit: 'л' });

  // Plain numbers
  assert.deepStrictEqual(parseQuantityAndUnit('12'), { qty: 12, unit: undefined });
  assert.deepStrictEqual(parseQuantityAndUnit('4.5'), { qty: 4.5, unit: undefined });
});

test('parseInvoiceEditText edits single line with formula and gram pricing', () => {
  const initial: InvoiceData = {
    date: '10.10.2026',
    supplier: 'Ферма',
    warehouse: 'kitchen',
    items: [
      { name: 'Говядина', qty: 10, price: 500, sum: 5000, unit: 'кг' },
      { name: 'Лук', qty: 20, price: 30, sum: 600, unit: 'кг' }
    ],
    total_written: 5600
  };

  // 1. Edit quantity and price: "1: 15 * 580"
  const res1 = parseInvoiceEditText('1: 15 * 580', initial);
  assert.strictEqual(res1.success, true);
  assert.strictEqual(res1.data?.items[0].qty, 15);
  assert.strictEqual(res1.data?.items[0].price, 580);
  assert.strictEqual(res1.data?.items[0].sum, 8700);

  // 2. Compact format: "1 12 600"
  const res2 = parseInvoiceEditText('1 12 600', initial);
  assert.strictEqual(res2.success, true);
  assert.strictEqual(res2.data?.items[0].qty, 12);
  assert.strictEqual(res2.data?.items[0].price, 600);

  // 3. Grams with total sum: "1: 500г = 250"
  const res3 = parseInvoiceEditText('1: 500г = 250', initial);
  assert.strictEqual(res3.success, true);
  assert.strictEqual(res3.data?.items[0].qty, 0.5);
  assert.strictEqual(res3.data?.items[0].price, 500); // 250 / 0.5
  assert.strictEqual(res3.data?.items[0].sum, 250);
});

test('parseInvoiceEditText supports deleting and adding items', () => {
  const initial: InvoiceData = {
    date: '10.10.2026',
    supplier: 'Ферма',
    warehouse: 'kitchen',
    items: [
      { name: 'Говядина', qty: 10, price: 500, sum: 5000 },
      { name: 'Лук', qty: 20, price: 30, sum: 600 },
      { name: 'Сыр', qty: 5, price: 400, sum: 2000 }
    ],
    total_written: 7600
  };

  // Delete line 2
  const delRes = parseInvoiceEditText('удалить 2', initial);
  assert.strictEqual(delRes.success, true);
  assert.strictEqual(delRes.data?.items.length, 2);
  assert.strictEqual(delRes.data?.items[1].name, 'Сыр');

  // Add line
  const addRes = parseInvoiceEditText('+ Кинза свежая 2 * 150', initial);
  assert.strictEqual(addRes.success, true);
  assert.strictEqual(addRes.data?.items.length, 4);
  assert.strictEqual(addRes.data?.items[3].name, 'Кинза свежая');
  assert.strictEqual(addRes.data?.items[3].qty, 2);
  assert.strictEqual(addRes.data?.items[3].price, 150);
});

test('parseInvoiceEditText supports changing supplier, date and warehouse', () => {
  const initial: InvoiceData = {
    date: '10.10.2026',
    supplier: 'Ферма',
    warehouse: 'kitchen',
    items: [{ name: 'Говядина', qty: 10, price: 500, sum: 5000 }],
    total_written: 5000
  };

  // Change supplier
  const supRes = parseInvoiceEditText('поставщик: Мясной Двор', initial);
  assert.strictEqual(supRes.success, true);
  assert.strictEqual(supRes.data?.supplier, 'Мясной Двор');

  // Change date
  const dateRes = parseInvoiceEditText('дата: 15.11.2026', initial);
  assert.strictEqual(dateRes.success, true);
  assert.strictEqual(dateRes.data?.date, '15.11.2026');

  // Change warehouse
  const whRes = parseInvoiceEditText('склад: хоз', initial);
  assert.strictEqual(whRes.success, true);
  assert.strictEqual(whRes.data?.warehouse, 'household');
});

test('parseInvoiceEditText parses full multi-line block', () => {
  const block = `
Поставщик: Овощной Базар
Дата: 25.10.2026
Склад: Кухня
1. Картофель: 50кг * 40
2. Томаты: 15кг * 180
3. Зелень: 5 * 100
`;

  const dummy: InvoiceData = {
    date: '',
    supplier: '',
    warehouse: 'kitchen',
    items: []
  };

  const res = parseInvoiceEditText(block, dummy);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.data?.supplier, 'Овощной Базар');
  assert.strictEqual(res.data?.date, '25.10.2026');
  assert.strictEqual(res.data?.warehouse, 'kitchen');
  assert.strictEqual(res.data?.items.length, 3);
  assert.strictEqual(res.data?.items[0].name, 'Картофель');
  assert.strictEqual(res.data?.items[0].qty, 50);
  assert.strictEqual(res.data?.items[0].price, 40);
  assert.strictEqual(res.data?.items[0].unit, 'кг');
});

test('formatEditableInvoice generates tap-to-copy text format', () => {
  const data: InvoiceData = {
    date: '12.10.2026',
    supplier: 'Бойня',
    warehouse: 'kitchen',
    items: [
      { name: 'Говядина', qty: 10, price: 600, sum: 6000, unit: 'кг' },
      { name: 'Оливки', qty: 2, price: 180, sum: 360, unit: 'бан' }
    ]
  };

  const text = formatEditableInvoice(data);
  assert.match(text, /Поставщик:\s*Бойня/);
  assert.match(text, /Дата:\s*12\.10\.2026/);
  assert.match(text, /1\.\s*Говядина:\s*10\s*кг\s*\*\s*600/);
  assert.match(text, /2\.\s*Оливки:\s*2\s*бан\s*\*\s*180/);
});
