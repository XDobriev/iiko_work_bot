import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiInvoiceRecognizer, RecognizerProgress } from '../src/gemini/recognizer.js';

test('GeminiInvoiceRecognizer switches instantly on HTTP 429 Quota Exceeded without delay', async () => {
  const originalFetch = globalThis.fetch;
  const modelsCalled: string[] = [];

  globalThis.fetch = (async (url: string) => {
    const modelMatch = url.match(/models\/([^:]+):/);
    const model = modelMatch ? modelMatch[1] : 'unknown';
    modelsCalled.push(model);

    if (model === 'model-primary') {
      // Return 429 Quota Exceeded
      return new Response('RESOURCE_EXHAUSTED: quota exceeded', {
        status: 429,
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    // Backup model succeeds with valid invoice JSON
    const validJson = {
      date: '16.11.2026',
      supplier: 'Бойня Резерв',
      warehouse: 'kitchen',
      items: [{ name: 'Мясо', qty: 5, price: 500, sum: 2500, unit: 'кг' }]
    };

    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(validJson) }] } }]
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as any;

  try {
    const recognizer = new GeminiInvoiceRecognizer('test-api-key', {
      photoModels: ['model-primary', 'model-backup']
    });

    const start = Date.now();
    const result = await recognizer.recognize(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    const duration = Date.now() - start;

    assert.strictEqual(result.supplier, 'Бойня Резерв');
    assert.strictEqual(result.model_used, 'model-backup');
    // Primary was called once and immediately switched to backup without waiting 1.5s
    assert.deepStrictEqual(modelsCalled, ['model-primary', 'model-backup']);
    assert.ok(duration < 1000, `Expected instant switch < 1000ms, took ${duration}ms`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GeminiInvoiceRecognizer throws instantly on HTTP 401 Auth error', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    return new Response('API_KEY_INVALID', {
      status: 401,
      headers: { 'Content-Type': 'text/plain' }
    });
  }) as any;

  try {
    const recognizer = new GeminiInvoiceRecognizer('bad-key', ['model-1', 'model-2']);
    await assert.rejects(
      async () => {
        await recognizer.recognize(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      },
      /401.*GEMINI_API_KEY/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GeminiInvoiceRecognizer detects stalled stream and switches to backup model', async () => {
  const originalFetch = globalThis.fetch;
  const modelsTried: string[] = [];

  globalThis.fetch = (async (url: string, init?: any) => {
    const modelMatch = url.match(/models\/([^:]+):/);
    const model = modelMatch ? modelMatch[1] : 'unknown';
    modelsTried.push(model);

    if (model === 'stalling-model') {
      // Simulate stalled stream: never emits any data chunks until signal aborts
      const stream = new ReadableStream({
        start(controller) {
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              try { controller.close(); } catch {}
            });
          }
        }
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }

    // Backup model returns fast JSON
    const validJson = {
      date: '16.11.2026',
      supplier: 'Быстрый Резерв',
      warehouse: 'kitchen',
      items: [{ name: 'Сыр', qty: 2, price: 400, sum: 800, unit: 'кг' }]
    };

    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(validJson) }] } }]
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as any;

  try {
    const recognizer = new GeminiInvoiceRecognizer('test-api-key', {
      photoModels: ['stalling-model', 'fast-reserve-model']
    });

    const progressTicks: RecognizerProgress[] = [];

    // Set stalled timeout to 80ms for fast test verification
    const result = await recognizer.recognize(
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      {
        stalledTimeoutMs: 80,
        timeoutMs: 5000,
        onProgress: (p) => progressTicks.push(p)
      }
    );

    assert.strictEqual(result.supplier, 'Быстрый Резерв');
    assert.strictEqual(result.model_used, 'fast-reserve-model');
    assert.ok(modelsTried.includes('stalling-model'));
    assert.ok(modelsTried.includes('fast-reserve-model'));
    assert.ok(progressTicks.length > 0, 'Progress ticks should be reported during recognition');
    assert.strictEqual(progressTicks[0].active, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GeminiInvoiceRecognizer switches instantly on HTTP 400 Bad Request to backup model', async () => {
  const originalFetch = globalThis.fetch;
  const modelsCalled: string[] = [];

  globalThis.fetch = (async (url: string) => {
    const modelMatch = url.match(/models\/([^:]+):/);
    const model = modelMatch ? modelMatch[1] : 'unknown';
    modelsCalled.push(model);

    if (model === 'bad-request-model') {
      return new Response('INVALID_ARGUMENT: unsupported image format', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    const validJson = {
      date: '16.11.2026',
      supplier: 'Поставщик Резерв',
      warehouse: 'kitchen',
      items: [{ name: 'Хлеб', qty: 10, price: 50, sum: 500, unit: 'шт' }]
    };

    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(validJson) }] } }]
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as any;

  try {
    const recognizer = new GeminiInvoiceRecognizer('test-api-key', {
      photoModels: ['bad-request-model', 'working-backup']
    });

    const start = Date.now();
    const result = await recognizer.recognize(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    const duration = Date.now() - start;

    assert.strictEqual(result.supplier, 'Поставщик Резерв');
    assert.strictEqual(result.model_used, 'working-backup');
    assert.deepStrictEqual(modelsCalled, ['bad-request-model', 'working-backup']);
    assert.ok(duration < 1000, `Expected instant switch < 1000ms, took ${duration}ms`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GeminiInvoiceRecognizer switches to backup model on total timeout expiration', async () => {
  const originalFetch = globalThis.fetch;
  const modelsCalled: string[] = [];

  globalThis.fetch = (async (url: string, init?: any) => {
    const modelMatch = url.match(/models\/([^:]+):/);
    const model = modelMatch ? modelMatch[1] : 'unknown';
    modelsCalled.push(model);

    if (model === 'slow-model') {
      // Simulate continuous drip stream that takes too long overall
      const stream = new ReadableStream({
        start(controller) {
          const interval = setInterval(() => {
            if (init?.signal?.aborted) {
              clearInterval(interval);
              try { controller.close(); } catch {}
              return;
            }
            try {
              controller.enqueue(new TextEncoder().encode(': keepalive\n\n'));
            } catch {
              clearInterval(interval);
            }
          }, 20);

          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              clearInterval(interval);
              try { controller.close(); } catch {}
            });
          }
        }
      });

      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }

    const validJson = {
      date: '16.11.2026',
      supplier: 'Быстрый Финиш',
      warehouse: 'kitchen',
      items: [{ name: 'Молоко', qty: 3, price: 100, sum: 300, unit: 'л' }]
    };

    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(validJson) }] } }]
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as any;

  try {
    const recognizer = new GeminiInvoiceRecognizer('test-api-key', {
      photoModels: ['slow-model', 'fast-finish']
    });

    const result = await recognizer.recognize(
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      {
        timeoutMs: 120, // 120ms total timeout for test
        stalledTimeoutMs: 500
      }
    );

    assert.strictEqual(result.supplier, 'Быстрый Финиш');
    assert.strictEqual(result.model_used, 'fast-finish');
    assert.ok(modelsCalled.includes('slow-model'));
    assert.ok(modelsCalled.includes('fast-finish'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GeminiInvoiceRecognizer flushes unflushed buffer when SSE stream closes without trailing newline', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    const validJson = {
      date: '16.11.2026',
      supplier: 'Поставщик Буфер',
      warehouse: 'kitchen',
      items: [{ name: 'Мука', qty: 5, price: 60, sum: 300, unit: 'кг' }]
    };

    // SSE event chunk without trailing \n
    const chunkText = `data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(validJson) }] } }]
    })}`;

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(chunkText));
        controller.close();
      }
    });

    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    });
  }) as any;

  try {
    const recognizer = new GeminiInvoiceRecognizer('test-api-key', { photoModels: ['stream-test-model'] });
    const result = await recognizer.recognize(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    assert.strictEqual(result.supplier, 'Поставщик Буфер');
    assert.strictEqual(result.items.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GeminiInvoiceRecognizer detects in-stream 429 quota error chunk and switches to backup model', async () => {
  const originalFetch = globalThis.fetch;
  const modelsCalled: string[] = [];

  globalThis.fetch = (async (url: string) => {
    const modelMatch = url.match(/models\/([^:]+):/);
    const model = modelMatch ? modelMatch[1] : 'unknown';
    modelsCalled.push(model);

    if (model === 'stream-429-model') {
      const errorChunk = `data: ${JSON.stringify({
        error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).' }
      })}\n\n`;

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(errorChunk));
          controller.close();
        }
      });

      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }

    const validJson = {
      date: '16.11.2026',
      supplier: 'Резерв Стрим',
      warehouse: 'kitchen',
      items: [{ name: 'Сахар', qty: 10, price: 50, sum: 500, unit: 'кг' }]
    };

    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(validJson) }] } }]
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as any;

  try {
    const recognizer = new GeminiInvoiceRecognizer('test-api-key', {
      photoModels: ['stream-429-model', 'stream-backup-model']
    });

    const result = await recognizer.recognize(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    assert.strictEqual(result.supplier, 'Резерв Стрим');
    assert.strictEqual(result.model_used, 'stream-backup-model');
    assert.deepStrictEqual(modelsCalled, ['stream-429-model', 'stream-backup-model']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
