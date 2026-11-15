import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatModelReportHtml,
  formatModelReportConsole,
  ModelCheckReport
} from '../src/gemini/model-checker.js';

test('formatModelReportHtml formats report cleanly with HTML escaping', () => {
  const fakeReport: ModelCheckReport = {
    timestamp: '2026-11-15T21:00:00.000Z',
    totalGoogleModels: 45,
    allGeminiModels: ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.5-transcribe'],
    configured: [
      {
        model: 'gemini-3.5-flash-lite',
        role: 'photo',
        inGoogleList: true,
        pingOk: true,
        latencyMs: 450,
        displayName: 'Gemini 3.5 Flash-Lite'
      },
      {
        model: 'gemini-unknown<test>',
        role: 'complex',
        inGoogleList: false,
        pingOk: false,
        error: 'Not found & failed'
      }
    ],
    recommendations: ['gemini-3.8-flash', 'gemini-2.5-pro']
  };

  const html = formatModelReportHtml(fakeReport);

  // Escaping
  assert.ok(!html.includes('gemini-unknown<test>'));
  assert.ok(html.includes('gemini-unknown&lt;test&gt;'));
  assert.ok(html.includes('450 мс'));
  assert.match(html, /Фото \(накладные\)/);
  assert.match(html, /Сложные чеки/);
  assert.match(html, /gemini-3\.8-flash/);
  assert.match(html, /нет в списке Google API/);
});

test('formatModelReportConsole formats readable CLI output', () => {
  const fakeReport: ModelCheckReport = {
    timestamp: '2026-11-15T21:00:00.000Z',
    totalGoogleModels: 45,
    allGeminiModels: ['gemini-3.5-flash-lite'],
    configured: [
      {
        model: 'gemini-3.5-flash-lite',
        role: 'photo',
        inGoogleList: true,
        pingOk: true,
        latencyMs: 320
      }
    ],
    recommendations: ['gemini-3.8-flash']
  };

  const text = formatModelReportConsole(fakeReport);
  assert.match(text, /ПРОВЕРКА АКТУАЛЬНОСТИ И ДОСТУПНОСТИ МОДЕЛЕЙ GEMINI/);
  assert.match(text, /gemini-3\.5-flash-lite/);
  assert.match(text, /320ms/);
  assert.match(text, /РЕКОМЕНДАЦИИ/);
  assert.match(text, /gemini-3\.8-flash/);
});

test('pingModel sends x-goog-api-key header and lightweight prompt', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedHeaders: Record<string, string> = {};
  let capturedBody = '';

  globalThis.fetch = (async (url: string, init?: any) => {
    capturedUrl = url;
    capturedHeaders = init?.headers || {};
    capturedBody = init?.body || '';
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '2' }] } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as any;

  try {
    const { pingModel } = await import('../src/gemini/model-checker.js');
    const res = await pingModel('test-ping-model', 'secret-key-123');

    assert.strictEqual(res.ok, true);
    assert.ok(capturedUrl.includes('test-ping-model:generateContent'));
    assert.strictEqual(capturedHeaders['x-goog-api-key'], 'secret-key-123');
    assert.ok(capturedBody.includes('1+1='));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
