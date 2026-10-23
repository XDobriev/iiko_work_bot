import { InvoiceData, HistoricalComparison } from '../types/index.js';
import { DailyStats } from '../db/invoices.repo.js';

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
    `🏭 <b>Склад:</b> ${whIcon} <b>${escapeHtml(whName)}</b>`,
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
  tableLines.push('#  Наименование        Кол-во     Цена   Сумма');
  tableLines.push('──────────────────────────────────────────────');

  let calcTotal = 0;
  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i];
    const itemSum = item.sum || item.qty * item.price;
    calcTotal += itemSum;

    const num = (i + 1).toString().padEnd(2, ' ');
    let name = item.name.length > 17 ? item.name.substring(0, 15) + '..' : item.name;
    name = name.padEnd(17, ' ');

    const unit = item.unit || 'шт';
    const qtyVal = item.qty % 1 === 0 ? item.qty.toString() : item.qty.toFixed(2);
    const qtyStr = `${qtyVal} ${unit}`.padEnd(9, ' ');

    const price = Math.round(item.price).toString().padStart(6, ' ');
    const sum = Math.round(itemSum).toString().padStart(7, ' ');

    tableLines.push(`${num} ${name} ${qtyStr} ${price} ${sum}`);
  }

  tableLines.push('──────────────────────────────────────────────');
  tableLines.push(`               ИТОГО:           ${Math.round(calcTotal).toString().padStart(8, ' ')}`);

  lines.push(`<pre>${escapeHtml(tableLines.join('\n'))}</pre>`);

  // Math discrepancy
  if (comparison.mathDiscrepancy && data.total_written != null) {
    lines.push(
      `⚠️ <b>Расхождение в сумме!</b>\nНа чеке написано от руки: <b>${Math.round(data.total_written)} ₽</b>, а сумма позиций: <b>${Math.round(calcTotal)} ₽</b> (разница: ${Math.round(comparison.discrepancyDiff)} ₽).`
    );
  }

  // Unit / Packaging Anomalies
  const anomalies = comparison.priceComparisons.filter(c => c.isAnomaly && c.anomalyMessage);
  if (anomalies.length > 0) {
    lines.push('\n🔍 <b>Внимание: проверка фасовки / тары:</b>');
    for (const a of anomalies) {
      lines.push(`⚠️ <b>${escapeHtml(a.name)}</b>: ${escapeHtml(a.anomalyMessage || '')}`);
    }
  }

  // Price history insights (excluding anomalies already reported if needed, or including trends)
  const changedPrices = comparison.priceComparisons.filter(c => (c.trend === 'up' || c.trend === 'down') && !c.isAnomaly);
  if (changedPrices.length > 0) {
    lines.push('\n📊 <b>Сверка с предыдущими ценами:</b>');
    for (const cp of changedPrices) {
      const uStr = cp.currentUnit ? `/${cp.currentUnit}` : '';
      if (cp.trend === 'up') {
        lines.push(
          `🔺 <b>${escapeHtml(cp.name)}</b>: <b>${cp.currentPrice} ₽${uStr}</b> (+${cp.deltaRub} ₽ / +${cp.deltaPercent}% к ${escapeHtml(cp.previousDate || 'прошлому разу')})`
        );
      } else if (cp.trend === 'down') {
        lines.push(
          `🔻 <b>${escapeHtml(cp.name)}</b>: <b>${cp.currentPrice} ₽${uStr}</b> (${cp.deltaRub} ₽ / ${cp.deltaPercent}% к ${escapeHtml(cp.previousDate || 'прошлому разу')})`
        );
      }
    }
  }

  return lines.join('\n');
}

export function formatDailyStats(stats: DailyStats): string {
  if (stats.totalInvoices === 0) {
    return `📊 <b>Отчет за ${escapeHtml(stats.date)}:</b>\n\nЗа сегодня накладных ещё не поступало.`;
  }

  const lines = [
    `📊 <b>Сводный отчет за ${escapeHtml(stats.date)}:</b>`,
    '',
    `🧾 Всего накладных: <b>${stats.totalInvoices}</b>`,
    `💰 Общая сумма закупок: <b>${stats.totalSpend.toLocaleString('ru-RU')} ₽</b>`,
    `   🍽 Кухня (продукты): <b>${stats.kitchenSpend.toLocaleString('ru-RU')} ₽</b>`,
    `   🏠 Хоз склад: <b>${stats.householdSpend.toLocaleString('ru-RU')} ₽</b>`,
    '',
    '🚛 <b>Поставщики за сегодня:</b>'
  ];

  for (const s of stats.suppliers) {
    lines.push(`• <b>${escapeHtml(s.supplier)}</b>: ${s.count} накл. на <b>${s.total.toLocaleString('ru-RU')} ₽</b>`);
  }

  return lines.join('\n');
}
