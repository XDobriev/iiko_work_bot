import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWebappUrl } from '../src/config.js';
import { createInvoiceKeyboard, createEditKeyboard } from '../src/bot/bot.js';

test('normalizeWebappUrl sanitizes protocols and trailing slashes', () => {
  assert.strictEqual(normalizeWebappUrl(''), '');
  assert.strictEqual(normalizeWebappUrl(undefined), '');
  assert.strictEqual(normalizeWebappUrl('   '), '');

  // Bare domain auto-prepends https://
  assert.strictEqual(normalizeWebappUrl('iiko-bot-khamzatd.amvera.io'), 'https://iiko-bot-khamzatd.amvera.io');
  assert.strictEqual(normalizeWebappUrl('iiko-bot-khamzatd.amvera.io///'), 'https://iiko-bot-khamzatd.amvera.io');

  // Existing https preserves protocol
  assert.strictEqual(normalizeWebappUrl('https://my-tunnel.loca.lt/webapp/'), 'https://my-tunnel.loca.lt/webapp');

  // Existing http preserves protocol
  assert.strictEqual(normalizeWebappUrl('http://localhost:3000/'), 'http://localhost:3000');
});

test('createInvoiceKeyboard strictly enforces HTTPS for Telegram web_app button', () => {
  // 1. Valid HTTPS url creates web_app button
  const kbHttps = createInvoiceKeyboard(42, true, 'https://iiko-bot.amvera.io', false);
  const row2Https = kbHttps.inline_keyboard[1];
  const miniAppBtn = row2Https.find(b => b.text.includes('Mini App'));
  assert.ok(miniAppBtn, 'Should have Mini App button on row 2');
  assert.ok('web_app' in miniAppBtn, 'Mini App button must have web_app payload');
  assert.strictEqual((miniAppBtn as any).web_app.url, 'https://iiko-bot.amvera.io?invoiceId=42');

  // 2. Insecure HTTP url MUST NOT create web_app button to prevent Telegram 400 Bad Request
  const kbHttp = createInvoiceKeyboard(42, true, 'http://insecure.local', false);
  const row2Http = kbHttp.inline_keyboard[1];
  const miniAppBtnHttp = row2Http.find(b => b.text.includes('Mini App'));
  assert.strictEqual(miniAppBtnHttp, undefined, 'Must not use web_app button with http://');
  assert.ok(row2Http.some(b => b.text.includes('Наговорить')), 'Falls back safely to text edit button');

  // 3. Empty url falls back cleanly
  const kbEmpty = createInvoiceKeyboard(42, true, '', false);
  assert.strictEqual(kbEmpty.inline_keyboard.length, 2);
});

test('createEditKeyboard embeds Mini App button when HTTPS is configured', () => {
  // When webAppUrl is empty or not https
  const defaultKb = createEditKeyboard(42, false, '');
  assert.ok(!defaultKb.inline_keyboard.some(row => row.some(b => b.text.includes('Mini App'))));

  // When webAppUrl is valid https
  const httpsKb = createEditKeyboard(42, false, 'https://example.com/webapp');
  assert.ok(httpsKb.inline_keyboard.some(row => row.some(b => b.text.includes('Mini App'))));
});
