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

  // Task-specific models via object configuration
  const recTasks = new GeminiInvoiceRecognizer('fake-key', {
    models: ['gen-1'],
    photoModels: ['photo-1', 'photo-2'],
    voiceModels: ['voice-1'],
    complexModels: ['complex-1', 'complex-2']
  });
  assert.deepStrictEqual(recTasks.getCandidateModels('photo'), ['photo-1', 'photo-2']);
  assert.deepStrictEqual(recTasks.getCandidateModels('voice'), ['voice-1']);
  assert.deepStrictEqual(recTasks.getCandidateModels('complex'), ['complex-1', 'complex-2']);
  assert.deepStrictEqual(recTasks.getCandidateModels(), ['gen-1']);
});

test('InvoiceDataSchema preserves model_used field', () => {
  const data = {
    date: '15.11.2026',
    supplier: 'Бойня',
    warehouse: 'kitchen',
    items: [{ name: 'Мясо', qty: 1, price: 500, sum: 500 }],
    model_used: 'gemini-3.5-flash (эскалация)'
  };

  const parsed = InvoiceDataSchema.parse(data);
  assert.strictEqual(parsed.model_used, 'gemini-3.5-flash (эскалация)');
});

test('Cascade escalation triggers and improves total_written discrepancy', async () => {
  const recognizer = new GeminiInvoiceRecognizer('fake-key', {
    photoModels: ['fast-lite'],
    complexModels: ['deep-pro']
  });

  const dummyImage = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  let callCount = 0;
  const modelsPassed: string[][] = [];

  (recognizer as any).executeGenerateContent = async (_body: any, _isVoice: boolean, modelsList: string[]) => {
    callCount++;
    modelsPassed.push(modelsList);

    if (callCount === 1) {
      // Primary model made a digit error (1 vs 7 on qty): 10 * 500 = 5000, but written total is 8500
      return {
        date: '15.11.2026',
        supplier: 'Бойня',
        warehouse: 'kitchen',
        items: [{ name: 'Говядина', qty: 10, price: 500, sum: 5000 }],
        total_written: 8500,
        model_used: 'fast-lite'
      };
    } else {
      // Escalated model fixed the digit (17 * 500 = 8500)
      return {
        date: '15.11.2026',
        supplier: 'Бойня',
        warehouse: 'kitchen',
        items: [{ name: 'Говядина', qty: 17, price: 500, sum: 8500 }],
        total_written: 8500,
        model_used: 'deep-pro'
      };
    }
  };

  const result = await recognizer.recognize(dummyImage);
  assert.strictEqual(callCount, 2, 'Should invoke escalation model');
  assert.deepStrictEqual(modelsPassed[0], ['fast-lite']);
  assert.deepStrictEqual(modelsPassed[1], ['deep-pro']);
  assert.strictEqual(result.model_used, 'deep-pro (эскалация)');
  assert.strictEqual(result.items[0].qty, 17);
  assert.strictEqual(result.items[0].sum, 8500);
});

test('Cascade escalation triggers on empty items and recovers lines', async () => {
  const recognizer = new GeminiInvoiceRecognizer('fake-key', {
    photoModels: ['fast-lite'],
    complexModels: ['deep-pro']
  });

  const dummyImage = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  let callCount = 0;

  (recognizer as any).executeGenerateContent = async () => {
    callCount++;
    if (callCount === 1) {
      return {
        date: '15.11.2026',
        supplier: 'Бойня',
        warehouse: 'kitchen',
        items: [],
        total_written: null,
        model_used: 'fast-lite'
      };
    } else {
      return {
        date: '15.11.2026',
        supplier: 'Бойня',
        warehouse: 'kitchen',
        items: [{ name: 'Форель', qty: 3, price: 1000, sum: 3000 }],
        total_written: 3000,
        model_used: 'deep-pro'
      };
    }
  };

  const result = await recognizer.recognize(dummyImage);
  assert.strictEqual(callCount, 2);
  assert.strictEqual(result.model_used, 'deep-pro (эскалация)');
  assert.strictEqual(result.items.length, 1);
});

test('Cascade escalation triggers on row-level math discrepancy even if total_written is null', async () => {
  const recognizer = new GeminiInvoiceRecognizer('fake-key', {
    photoModels: ['fast-lite'],
    complexModels: ['deep-pro']
  });

  const dummyImage = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  let callCount = 0;

  (recognizer as any).executeGenerateContent = async () => {
    callCount++;
    if (callCount === 1) {
      // Row math is broken: 15 * 580 != 5800
      return {
        date: '15.11.2026',
        supplier: 'Бойня',
        warehouse: 'kitchen',
        items: [{ name: 'Мясо', qty: 15, price: 580, sum: 5800 }],
        total_written: null,
        model_used: 'fast-lite'
      };
    } else {
      // Escalated model fixed the row math: 15 * 580 = 8700
      return {
        date: '15.11.2026',
        supplier: 'Бойня',
        warehouse: 'kitchen',
        items: [{ name: 'Мясо', qty: 15, price: 580, sum: 8700 }],
        total_written: null,
        model_used: 'deep-pro'
      };
    }
  };

  const result = await recognizer.recognize(dummyImage);
  assert.strictEqual(callCount, 2);
  assert.strictEqual(result.model_used, 'deep-pro (эскалация)');
  assert.strictEqual(result.items[0].sum, 8700);
});

test('Cascade escalation falls back to initialResult if escalation does not improve discrepancy', async () => {
  const recognizer = new GeminiInvoiceRecognizer('fake-key', {
    photoModels: ['fast-lite'],
    complexModels: ['deep-pro']
  });

  const dummyImage = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  let callCount = 0;

  (recognizer as any).executeGenerateContent = async () => {
    callCount++;
    if (callCount === 1) {
      return {
        date: '15.11.2026',
        supplier: 'Бойня',
        warehouse: 'kitchen',
        items: [{ name: 'Мясо', qty: 10, price: 500, sum: 5000 }],
        total_written: 6000,
        model_used: 'fast-lite'
      };
    } else {
      // Escalation got even worse or hallucinated 0 items
      return {
        date: '15.11.2026',
        supplier: 'Бойня',
        warehouse: 'kitchen',
        items: [],
        total_written: 6000,
        model_used: 'deep-pro'
      };
    }
  };

  const result = await recognizer.recognize(dummyImage);
  assert.strictEqual(callCount, 2);
  assert.strictEqual(result.model_used, 'fast-lite');
  assert.strictEqual(result.items.length, 1);
});

test('Voice edit uses voice candidate models', async () => {
  const recognizer = new GeminiInvoiceRecognizer('fake-key', {
    models: ['gen-model'],
    voiceModels: ['voice-whisper', 'voice-transcribe']
  });

  let taskUsed = '';
  (recognizer as any).executeEditGenerateContent = async (_body: any, task: string) => {
    taskUsed = task;
    return {
      data: {
        date: '15.11.2026',
        supplier: 'Бойня',
        warehouse: 'kitchen',
        items: [{ name: 'Мясо', qty: 2, price: 500, sum: 1000 }]
      },
      summary: 'Добавлено мясо'
    };
  };

  const audioBuf = Buffer.from([0x01, 0x02, 0x03]);
  await recognizer.recognizeVoiceEdit(
    { date: '15.11.2026', supplier: 'Бойня', warehouse: 'kitchen', items: [] },
    audioBuf
  );

  assert.strictEqual(taskUsed, 'voice');
});
