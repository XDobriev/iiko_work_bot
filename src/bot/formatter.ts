import { InvoiceData, HistoricalComparison } from '../types/index.js';

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function formatInvoiceMessage(
  invoiceId: number,
  data: InvoiceData,
  comparison: HistoricalComparison
): string {
  const isHousehold = data.warehouse === 'household';
  const whIcon = isHousehold ? '🏠' : '🍽';
  const whName = isHousehold ? 'Хоз склад' : 'Склад Кухня';

  const lines: string[] = [
    `📋 <b>Накладная #${invoiceId}</b>`,
    `📅 <b>Дата:</b> <code>${escapeHtml(data.date || 'Не указана')}</code>  |  🚛 <b>Поставщик:</b> <code>${escapeHtml(data.supplier || 'Не указан')}</code>`,
    `🏭 <b>Склад:</b> ${whIcon} <code>${escapeHtml(whName)}</code>`,
    ''
  ];

  // Duplicate warning
  if (comparison.isDuplicate) {
    lines.push(
      `⚠️ <b>ВНИМАНИЕ: Возможный дубликат!</b>\nНакладная от этого поставщика за эту дату уже загружена (ранее ID #${comparison.duplicateInvoiceId}).\n`
    );
  }

  // Preformatted Monospace Table
  const tableLines: string[] = [];
  tableLines.push('#  Наименование         Кол    Цена   Сумма');
  tableLines.push('─────────────────────────────────────────────');

  let calcTotal = 0;
  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i];
    const itemSum = item.sum || item.qty * item.price;
    calcTotal += itemSum;

    const num = (i + 1).toString().padEnd(2, ' ');
    let name = item.name.length > 18 ? item.name.substring(0, 16) + '..' : item.name;
    name = name.padEnd(18, ' ');

    const qty = item.qty.toFixed(item.qty % 1 === 0 ? 0 : 2).padEnd(6, ' ');
    const price = Math.round(item.price).toString().padStart(6, ' ');
    const sum = Math.round(itemSum).toString().padStart(7, ' ');

    tableLines.push(`${num} ${name} ${qty} ${price} ${sum}`);
  }

  tableLines.push('─────────────────────────────────────────────');
  tableLines.push(`               ИТОГО:           ${Math.round(calcTotal).toString().padStart(8, ' ')}`);

  lines.push(`<pre>${escapeHtml(tableLines.join('\n'))}</pre>`);

  // Math discrepancy
  if (comparison.mathDiscrepancy && data.total_written != null) {
    lines.push(
      `⚠️ <b>Расхождение в сумме!</b>\nНа чеке написано от руки: <b>${Math.round(data.total_written)} ₽</b>, а сумма позиций: <b>${Math.round(calcTotal)} ₽</b> (разница: ${Math.round(comparison.discrepancyDiff)} ₽).`
    );
  }

  // Price history insights
  const changedPrices = comparison.priceComparisons.filter(c => c.trend === 'up' || c.trend === 'down');
  if (changedPrices.length > 0) {
    lines.push('\n📊 <b>Сверка с предыдущими ценами:</b>');
    for (const cp of changedPrices) {
      if (cp.trend === 'up') {
        lines.push(
          `🔺 <b>${escapeHtml(cp.name)}</b>: <b>${cp.currentPrice} ₽</b> (+${cp.deltaRub} ₽ / +${cp.deltaPercent}% к ${escapeHtml(cp.previousDate || 'прошлому разу')})`
        );
      } else if (cp.trend === 'down') {
        lines.push(
          `🔻 <b>${escapeHtml(cp.name)}</b>: <b>${cp.currentPrice} ₽</b> (${cp.deltaRub} ₽ / ${cp.deltaPercent}% к ${escapeHtml(cp.previousDate || 'прошлому разу')})`
        );
      }
    }
  }

  return lines.join('\n');
}
