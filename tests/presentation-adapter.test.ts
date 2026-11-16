import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TelegramPresentationAdapter,
  HeadlessPresentationAdapter
} from '../src/presentation/telegram-adapter.js';
import { InvoiceData } from '../src/types/index.js';

test('TelegramPresentationAdapter formats HTML cards with safe escaping', () => {
  const adapter = new TelegramPresentationAdapter();
  const data: InvoiceData = {
    date: '16.11.2026',
    supplier: 'ИП <Иванов & Ко>',
    warehouse: 'kitchen',
    items: [
      { name: 'Сыр <Российский>', qty: 2, price: 500, sum: 1000, warehouse: 'kitchen' }
    ],
    total_written: 1000
  };

  const card = adapter.formatCard(10, data);
  assert.ok(card.includes('&lt;Иванов &amp; Ко&gt;'), 'Supplier must be HTML escaped');
  assert.ok(card.includes('&lt;Российский&gt;'), 'Item name must be HTML escaped');
  assert.ok(card.includes('Накладная #10'));

  const editable = adapter.formatEditable(data);
  assert.ok(editable.includes('Сыр <Российский>'), 'Editable text preserves raw content for editing');

  const voiceCard = adapter.formatVoiceCard(10, data);
  assert.ok(voiceCard.startsWith('🎙 <b>Голосовая накладная:</b>\n\n'));
  assert.ok(voiceCard.includes('&lt;Иванов &amp; Ко&gt;'));
});

test('HeadlessPresentationAdapter formats plain text summary without HTML markup', () => {
  const adapter = new HeadlessPresentationAdapter();
  const data: InvoiceData = {
    date: '16.11.2026',
    supplier: 'Овощи',
    warehouse: 'kitchen',
    items: [
      { name: 'Яблоки', qty: 3, price: 100, sum: 300, warehouse: 'kitchen' }
    ],
    total_written: 300
  };

  const card = adapter.formatCard(42, data);
  assert.equal(card, 'Invoice #42 | Овощи | 300 ₽ (kitchen)');

  const voiceCard = adapter.formatVoiceCard(42, data);
  assert.equal(voiceCard, '[Voice Invoice] Invoice #42 | Овощи | 300 ₽ (kitchen)');
  assert.ok(!voiceCard.includes('<b>') && !voiceCard.includes('</b>'), 'Headless adapter must never emit HTML tags');

  const editable = adapter.formatEditable(data);
  assert.equal(editable.trim(), '1: Яблоки 3 * 100');
});
