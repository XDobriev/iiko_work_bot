import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ProductCatalogMatcher,
  CatalogProduct,
  ProductMappingStore,
  normalizeIikoName,
  checkUnitMismatch,
  levenshteinDistance
} from '../src/iiko/matcher.js';

const mockCatalog: CatalogProduct[] = [
  { id: 'prod-beef', name: 'Говядина б/к мякоть охл', unit: 'кг' },
  { id: 'prod-onion', name: 'Лук репчатый свежий', unit: 'кг' },
  { id: 'prod-cheese', name: 'Сыр', unit: 'кг' },
  { id: 'prod-suluguni', name: 'Сыр Сулугуни', unit: 'кг' },
  { id: 'prod-gauda', name: 'Сыр Гауда 45% брусок', unit: 'кг' },
  { id: 'prod-olives', name: 'Оливки черные без косточки', unit: 'бан' },
  { id: 'prod-oil', name: 'Масло подсолнечное рафинированное', unit: 'л' },
  { id: 'prod-mayo', name: 'Майонез Провансаль 67%', unit: 'кг' }
];

test('levenshteinDistance computes correct edit distance', () => {
  assert.strictEqual(levenshteinDistance('говядина', 'говядина'), 0);
  assert.strictEqual(levenshteinDistance('майанез', 'майонез'), 1);
  assert.strictEqual(levenshteinDistance('маянез', 'майонез'), 2);
  assert.strictEqual(levenshteinDistance('лук', 'люк'), 1);
  assert.strictEqual(levenshteinDistance('томат', 'помидор'), 5);
});

test('checkUnitMismatch flags mismatched packaging categories', () => {
  // Cans vs kg -> mismatch!
  const res1 = checkUnitMismatch('бан', 'кг');
  assert.strictEqual(res1.mismatch, true);
  assert.match(res1.warning || '', /расхождение единиц/i);

  // Pieces vs kg -> mismatch!
  const res2 = checkUnitMismatch('шт', 'кг');
  assert.strictEqual(res2.mismatch, true);

  // Liters vs kg -> mismatch!
  const res3 = checkUnitMismatch('л', 'кг');
  assert.strictEqual(res3.mismatch, true);

  // kg vs kg -> compatible
  const res4 = checkUnitMismatch('кг', 'кг');
  assert.strictEqual(res4.mismatch, false);

  // g vs kg -> both weight, compatible
  const res5 = checkUnitMismatch('г', 'кг');
  assert.strictEqual(res5.mismatch, false);

  // Units with trailing dots: "кг." vs "шт" -> mismatch!
  const res6 = checkUnitMismatch('кг.', 'шт');
  assert.strictEqual(res6.mismatch, true, 'Unit with trailing dot must not be treated as unknown');

  // "бан." vs "кг" -> mismatch!
  const res7 = checkUnitMismatch('бан.', 'кг');
  assert.strictEqual(res7.mismatch, true);
});

test('ProductCatalogMatcher performs exact normalized match', () => {
  const matcher = new ProductCatalogMatcher(mockCatalog);
  const match = matcher.match('Сыр');
  assert.ok(match);
  assert.strictEqual(match.product.id, 'prod-cheese');
  assert.strictEqual(match.source, 'exact');
  assert.strictEqual(match.score, 1.0);
});

test('ProductCatalogMatcher eliminates naive substring bias: specific item matches specific product', () => {
  const matcher = new ProductCatalogMatcher(mockCatalog);

  // Query "Сыр Сулугуни" must match "Сыр Сулугуни", NOT "Сыр"
  const matchSuluguni = matcher.match('Сыр Сулугуни');
  assert.ok(matchSuluguni);
  assert.strictEqual(matchSuluguni.product.id, 'prod-suluguni');

  // Query "Сыр Гауда" must match "Сыр Гауда 45% брусок", NOT "Сыр"
  const matchGauda = matcher.match('Сыр Гауда');
  assert.ok(matchGauda);
  assert.strictEqual(matchGauda.product.id, 'prod-gauda');

  // Query "Говядина мякоть" must match "Говядина б/к мякоть охл"
  const matchBeef = matcher.match('Говядина мякоть');
  assert.ok(matchBeef);
  assert.strictEqual(matchBeef.product.id, 'prod-beef');
});

test('ProductCatalogMatcher uses explicit mapping from mappingStore', () => {
  const memoryStore: Record<string, { iikoProductName: string; iikoProductId?: string }> = {
    'мясо': { iikoProductName: 'Говядина б/к мякоть охл', iikoProductId: 'prod-beef' }
  };

  const mockStore: ProductMappingStore = {
    findProductMapping: (name) => memoryStore[name.toLowerCase().trim()] || null,
    saveProductMapping: (raw, prodName, prodId) => {
      memoryStore[raw.toLowerCase().trim()] = { iikoProductName: prodName, iikoProductId: prodId };
    }
  };

  const matcher = new ProductCatalogMatcher(mockCatalog, mockStore);

  // Before mapping, generic "мясо" might not match or have lower score
  const match = matcher.match('мясо');
  assert.ok(match);
  assert.strictEqual(match.product.id, 'prod-beef');
  assert.strictEqual(match.source, 'mapping');
  assert.strictEqual(match.score, 1.0);

  // Save new mapping and test
  matcher.saveMapping('зеленый лук', mockCatalog[1]); // prod-onion
  const matchSaved = matcher.match('зеленый лук');
  assert.ok(matchSaved);
  assert.strictEqual(matchSaved.product.id, 'prod-onion');
  assert.strictEqual(matchSaved.source, 'mapping');
});

test('ProductCatalogMatcher tolerates typos via fuzzy matching', () => {
  const matcher = new ProductCatalogMatcher(mockCatalog);

  // "Маянез" with typo -> "Майонез Провансаль 67%"
  const matchMayo = matcher.match('Маянез');
  assert.ok(matchMayo);
  assert.strictEqual(matchMayo.product.id, 'prod-mayo');
  assert.strictEqual(matchMayo.source, 'fuzzy');
});

test('ProductCatalogMatcher detects unit discrepancy on matched items', () => {
  const matcher = new ProductCatalogMatcher(mockCatalog);

  // Matched "Оливки" but invoice specified "кг", while catalog has "бан"
  const match = matcher.match('Оливки', 'кг');
  assert.ok(match);
  assert.strictEqual(match.product.id, 'prod-olives');
  assert.strictEqual(match.unitMismatch, true);
  assert.ok(match.unitWarning);
  assert.match(match.unitWarning, /расхождение единиц/i);
});

test('ProductCatalogMatcher rejects unrelated queries below threshold', () => {
  const matcher = new ProductCatalogMatcher(mockCatalog);

  // Completely unknown item
  const match = matcher.match('Стиральный порошок Автомат');
  assert.strictEqual(match, null);

  // Empty string
  assert.strictEqual(matcher.match(''), null);
  assert.strictEqual(matcher.match('   '), null);
});

test('IikoClient findEntityByName eliminates stop-word false positive matching', async () => {
  const { IikoClient } = await import('../src/iiko/client.js');
  const client = new IikoClient();

  const suppliers = [
    { id: '1', name: 'ООО "Мясо и Рыба"' },
    { id: '2', name: 'ИП Иванов Сергей' }
  ];

  // "ИП Петров" must NOT match "ООО Мясо и Рыба" via conjunction "и"
  const falseMatch = client.findEntityByName(suppliers, 'ИП Петров');
  assert.strictEqual(falseMatch, undefined, 'Must not falsely match unrelated entity via conjunction or legal prefix');

  // Valid supplier match
  const validMatch = client.findEntityByName(suppliers, 'Мясо и Рыба');
  assert.strictEqual(validMatch?.id, '1');

  const validMatch2 = client.findEntityByName(suppliers, 'Иванов Сергей');
  assert.strictEqual(validMatch2?.id, '2');
});
