import { InvoiceData, HistoricalComparison } from '../types/index.js';
import { formatInvoiceMessage } from '../bot/formatter.js';
import { formatEditableInvoice } from '../bot/parser.js';

export interface InvoicePresentationAdapter {
  formatCard(invoiceId: number, data: InvoiceData, comparison?: HistoricalComparison): string;
  formatVoiceCard(invoiceId: number, data: InvoiceData, comparison?: HistoricalComparison): string;
  formatEditable(data: InvoiceData): string;
}

const DEFAULT_COMPARISON: HistoricalComparison = {
  isDuplicate: false,
  priceComparisons: [],
  totalPriceDelta: 0,
  mathDiscrepancy: false,
  discrepancyDiff: 0
};

export class TelegramPresentationAdapter implements InvoicePresentationAdapter {
  formatCard(invoiceId: number, data: InvoiceData, comparison?: HistoricalComparison): string {
    return formatInvoiceMessage(invoiceId, data, comparison || DEFAULT_COMPARISON);
  }

  formatVoiceCard(invoiceId: number, data: InvoiceData, comparison?: HistoricalComparison): string {
    return `🎙 <b>Голосовая накладная:</b>\n\n` + this.formatCard(invoiceId, data, comparison);
  }

  formatEditable(data: InvoiceData): string {
    return formatEditableInvoice(data);
  }
}

export class HeadlessPresentationAdapter implements InvoicePresentationAdapter {
  formatCard(invoiceId: number, data: InvoiceData): string {
    const total = (data.items || []).reduce((acc, it) => acc + (it.sum || it.qty * it.price), 0);
    return `Invoice #${invoiceId} | ${data.supplier || 'Не указан'} | ${total} ₽ (${data.warehouse || 'kitchen'})`;
  }

  formatVoiceCard(invoiceId: number, data: InvoiceData): string {
    return `[Voice Invoice] ` + this.formatCard(invoiceId, data);
  }

  formatEditable(data: InvoiceData): string {
    return (data.items || []).map((it, i) => `${i + 1}: ${it.name} ${it.qty} * ${it.price}`).join('\n');
  }
}
