import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectImageMimeType,
  GEMINI_INVOICE_RESPONSE_SCHEMA,
  GeminiInvoiceRecognizer
} from '../src/gemini/recognizer.js';
import { InvoiceDataSchema } from '../src/types/index.js';

test('detectImageMimeType detects JPEG, PNG, WEBP and falls back to JPEG', () => {
  // JPEG magic bytes: FF D8 FF
  const jpegBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  assert.strictEqual(detectImageMimeType(jpegBuf), 'image/jpeg');

  // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
  const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.strictEqual(detectImageMimeType(pngBuf), 'image/png');

  // WEBP: RIFF + 4 bytes + WEBP
  const webpBuf = Buffer.from('RIFF1234WEBPVP8 ', 'ascii');
  assert.strictEqual(detectImageMimeType(webpBuf), 'image/webp');

  // Unknown buffer -> fallback to image/jpeg
  const unknownBuf = Buffer.from([0x00, 0x01, 0x02, 0x03]);
  assert.strictEqual(detectImageMimeType(unknownBuf), 'image/jpeg');
});

test('GEMINI_INVOICE_RESPONSE_SCHEMA defines required schema fields', () => {
  assert.strictEqual(GEMINI_INVOICE_RESPONSE_SCHEMA.type, 'OBJECT');
  assert.ok(GEMINI_INVOICE_RESPONSE_SCHEMA.properties.date);
  assert.ok(GEMINI_INVOICE_RESPONSE_SCHEMA.properties.supplier);
  assert.ok(GEMINI_INVOICE_RESPONSE_SCHEMA.properties.warehouse);
  assert.ok(GEMINI_INVOICE_RESPONSE_SCHEMA.properties.items);
  assert.deepStrictEqual(GEMINI_INVOICE_RESPONSE_SCHEMA.required, ['date', 'supplier', 'warehouse', 'items']);
});

test('InvoiceDataSchema validates compliant JSON and gracefully sanitizes fields', () => {
  const validJson = {
    date: '14.11.2026',
    supplier: 'Бойня',
    warehouse: 'kitchen',
    items: [
      { name: 'Говядина', qty: 10, price: 600, sum: 6000, unit: 'кг' }
    ],
    total_written: 6000,
    notes: 'Оплата наличными'
  };

  const parsed = InvoiceDataSchema.parse(validJson);
  assert.strictEqual(parsed.supplier, 'Бойня');
  assert.strictEqual(parsed.items.length, 1);
  assert.strictEqual(parsed.items[0].sum, 6000);

  // Sanitizes warehouse aliases
  const household = InvoiceDataSchema.parse({ ...validJson, warehouse: 'Хоз склад (бытовая химия)' });
  assert.strictEqual(household.warehouse, 'household');

  const kitchen = InvoiceDataSchema.parse({ ...validJson, warehouse: 'Продуктовый склад' });
  assert.strictEqual(kitchen.warehouse, 'kitchen');

  // Non-object input rejects
  assert.throws(() => {
    InvoiceDataSchema.parse(null);
  });
  assert.throws(() => {
    InvoiceDataSchema.parse('not a valid json object');
  });
});

test('GeminiInvoiceRecognizer configures candidate models properly', () => {
  const recCustom = new GeminiInvoiceRecognizer('fake-key', ['custom-model-1', 'custom-model-2']);
  assert.deepStrictEqual(recCustom.getCandidateModels(), ['custom-model-1', 'custom-model-2']);

  const recSingle = new GeminiInvoiceRecognizer('fake-key', 'single-primary-model');
  const candidates = recSingle.getCandidateModels();
  assert.strictEqual(candidates[0], 'single-primary-model');
  assert.ok(candidates.length >= 1);
});
