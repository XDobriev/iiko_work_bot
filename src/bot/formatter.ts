import { InvoiceData, HistoricalComparison } from '../types/index.js';

export function formatInvoiceMessage(
  invoiceId: number,
  data: InvoiceData,
  comparison: HistoricalComparison
): string {
  const isHousehold = data.warehouse === 'household';
  const whIcon = isHousehold ? '🏠' : '🍽';
  const whName = isHousehold ? 'Хоз склад' : 'Склад Кухня';

  const lines: string[] = [
    `📋 *Накладная #${invoiceId}*`,
    `📅 *Дата:* \`${data.date || 'Не указана'}\`  |  🚛 *Поставщик:* \`${data.supplier || 'Не указан'}\``,
    `🏭 *Склад:* ${whIcon} \`${whName}\``,
    ''
  ];

  // Duplicate warning
  if (comparison.isDuplicate) {
    lines.push(
      `⚠️ *ВНИМАНИЕ: Возможный дубликат!*\nНакладная от этого поставщика за эту дату уже загружена (ранее ID #${comparison.duplicateInvoiceId}).\n`
    );
  }

  // Monospace Table Header
  lines.push('```');
  lines.push('#  Наименование         Кол    Цена   Сумма');
  lines.push('─────────────────────────────────────────────');

  let calcTotal = 0;
  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i];
    const itemSum = item.sum || item.qty * item.price;
    calcTotal += itemSum;

    const num = (i + 1).toString().padEnd(2, ' ');
    // Truncate name cleanly
    let name = item.name.length > 18 ? item.name.substring(0, 16) + '..' : item.name;
    name = name.padEnd(18, ' ');

    const qty = item.qty.toFixed(item.qty % 1 === 0 ? 0 : 2).padEnd(6, ' ');
    const price = Math.round(item.price).toString().padStart(6, ' ');
    const sum = Math.round(itemSum).toString().padStart(7, ' ');

    lines.push(`${num} ${name} ${qty} ${price} ${sum}`);
  }

  lines.push('─────────────────────────────────────────────');
  lines.push(`               ИТОГО:           ${Math.round(calcTotal).toString().padStart(8, ' ')}`);
  lines.push('```');

  // Math discrepancy
  if (comparison.mathDiscrepancy && data.total_written != null) {
    lines.push(
      `⚠️ *Расхождение в сумме!*\nНа чеке написано от руки: *${Math.round(data.total_written)} ₽*, а сумма позиций: *${Math.round(calcTotal)} ₽* (разница: ${Math.round(comparison.discrepancyDiff)} ₽).`
    );
  }

  // Price history insights
  const changedPrices = comparison.priceComparisons.filter(c => c.trend === 'up' || c.trend === 'down');
  if (changedPrices.length > 0) {
    lines.push('\n📊 *Сверка с предыдущими ценами:*');
    for (const cp of changedPrices) {
      if (cp.trend === 'up') {
        lines.push(
          `🔺 *${cp.name}*: *${cp.currentPrice} ₽* (+${cp.deltaRub} ₽ / +${cp.deltaPercent}% к ${cp.previousDate || 'прошлому разу'})`
        );
      } else if (cp.trend === 'down') {
        lines.push(
          `🔻 *${cp.name}*: *${cp.currentPrice} ₽* (${cp.deltaRub} ₽ / ${cp.deltaPercent}% к ${cp.previousDate || 'прошлому разу'})`
        );
      }
    }
  }

  return lines.join('\n');
}
