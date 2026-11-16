import { InvoiceData, InvoiceItem, HistoricalComparison } from '../types/index.js';
import { DailyStats } from '../db/invoices.repo.js';
import { classifyItemWarehouse } from '../workflow/warehouse-classifier.js';

export function escapeHtml(str: any): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Safely balances unclosed Telegram HTML tags and guarantees message length <= 4096 characters.
 */
export function clampTelegramHtml(html: string, maxLen = 4000): string {
  if (html.length <= 4096) {
    return html;
  }

  const truncatedNotice = '\n\n✂️ <i>[Список сокращен: откройте Mini App для полной версии]</i>';
  let sliced = html.slice(0, maxLen - truncatedNotice.length);

  // If sliced in the middle of a tag like "<pre", remove the partial tag
  const lastLt = sliced.lastIndexOf('<');
  const lastGt = sliced.lastIndexOf('>');
  if (lastLt > lastGt) {
    sliced = sliced.slice(0, lastLt);
  }

  // If sliced in the middle of an HTML entity like "&amp", remove the partial entity
  sliced = sliced.replace(/&[a-zA-Z0-9#]*$/, '');

  // Balance tags
  const openTags: string[] = [];
  const tagRegex = /<\/?([a-zA-Z0-9]+)(?:\s+[^>]*)?>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(sliced)) !== null) {
    const fullTag = match[0];
    const tagName = match[1].toLowerCase();
    if (fullTag.startsWith('</')) {
      const lastIdx = openTags.lastIndexOf(tagName);
      if (lastIdx !== -1) {
        openTags.splice(lastIdx, 1);
      }
    } else if (!fullTag.endsWith('/>')) {
      openTags.push(tagName);
    }
  }

  // Close remaining open tags in reverse order
  let closingTags = '';
  for (let i = openTags.length - 1; i >= 0; i--) {
    closingTags += `</${openTags[i]}>`;
  }

  return sliced + closingTags + truncatedNotice;
}

function formatTableRow(index: number, item: InvoiceItem, itemSum: number): string {
  const num = (index + 1).toString().padEnd(2, ' ');
  let name = item.name.length > 17 ? item.name.substring(0, 15) + '..' : item.name;
  name = name.padEnd(17, ' ');

  const unit = item.unit || 'шт';
  const qtyVal = item.qty % 1 === 0 ? item.qty.toString() : item.qty.toFixed(2);
  const qtyStr = `${qtyVal} ${unit}`.padEnd(9, ' ');

  const price = Math.round(item.price).toString().padStart(6, ' ');
  const sum = Math.round(itemSum).toString().padStart(7, ' ');

  return `${num} ${name} ${qtyStr} ${price} ${sum}`;
}

export function formatInvoiceMessage(
  invoiceId: number,
  data: InvoiceData,
  comparison: HistoricalComparison
): string {
  const kitchenItems: Array<{ item: InvoiceItem; index: number }> = [];
  const householdItems: Array<{ item: InvoiceItem; index: number }> = [];

  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i];
    const wh = item.warehouse || classifyItemWarehouse(item.name, undefined, data.warehouse || 'kitchen');
    if (wh === 'household') {
      householdItems.push({ item, index: i });
    } else {
      kitchenItems.push({ item, index: i });
    }
  }

  const isMixed = kitchenItems.length > 0 && householdItems.length > 0;
  const isHousehold = !isMixed && (data.warehouse === 'household' || householdItems.length > 0);
  const whIcon = isMixed ? '🍽+🏠' : (isHousehold ? '🏠' : '🍽');
  const whName = isMixed
    ? '🍽 <b>Кухня</b> + 🏠 <b>Хоз склад</b> <i>(смешанная)</i>'
    : `<b>${escapeHtml(isHousehold ? 'Хоз склад' : 'Склад Кухня')}</b>`;

  const lines: string[] = [
    `📋 <b>Накладная #${invoiceId}</b>`,
    `📅 <b>Дата:</b> <code>${escapeHtml(data.date || 'Не указана')}</code>  |  🚛 <b>Поставщик:</b> <code>${escapeHtml(data.supplier || 'Не указан')}</code>`,
    `🏭 <b>Склад:</b> ${whName}`,
    ''
  ];

  // Duplicate warning
  if (comparison.isDuplicate) {
    lines.push(
      `⚠️ <b>ВНИМАНИЕ: Возможный дубликат!</b>\nНакладная от этого поставщика за эту дату уже загружена (ранее ID #${comparison.duplicateInvoiceId}).\n`
    );
  }

  let calcTotal = 0;
  const tableLines: string[] = [];

  if (isMixed) {
    // 1. Kitchen Block
    let kitchenSum = 0;
    tableLines.push('🍽 Склад Кухня (продукты):');
    tableLines.push('#  Наименование        Кол-во     Цена   Сумма');
    tableLines.push('──────────────────────────────────────────────');

    const shouldCompactKitchen = kitchenItems.length > 16;
    const kitchenHeadCount = shouldCompactKitchen ? 10 : kitchenItems.length;
    const kitchenTailCount = shouldCompactKitchen ? 2 : 0;

    for (let i = 0; i < kitchenItems.length; i++) {
      const { item, index } = kitchenItems[i];
      const itemSum = item.sum || item.qty * item.price;
      kitchenSum += itemSum;

      if (!shouldCompactKitchen || i < kitchenHeadCount || i >= kitchenItems.length - kitchenTailCount) {
        tableLines.push(formatTableRow(index, item, itemSum));
      } else if (i === kitchenHeadCount) {
        tableLines.push(`... и еще ${kitchenItems.length - kitchenHeadCount - kitchenTailCount} поз. (см. в Mini App) ...`);
      }
    }

    tableLines.push('──────────────────────────────────────────────');
    tableLines.push(`   Подытог Кухня:               ${Math.round(kitchenSum).toString().padStart(8, ' ')}`);
    tableLines.push('');

    // 2. Household Block
    let houseSum = 0;
    tableLines.push('🏠 Хоз склад (хозтовары):');
    tableLines.push('#  Наименование        Кол-во     Цена   Сумма');
    tableLines.push('──────────────────────────────────────────────');

    const shouldCompactHouse = householdItems.length > 16;
    const houseHeadCount = shouldCompactHouse ? 10 : householdItems.length;
    const houseTailCount = shouldCompactHouse ? 2 : 0;

    for (let i = 0; i < householdItems.length; i++) {
      const { item, index } = householdItems[i];
      const itemSum = item.sum || item.qty * item.price;
      houseSum += itemSum;

      if (!shouldCompactHouse || i < houseHeadCount || i >= householdItems.length - houseTailCount) {
        tableLines.push(formatTableRow(index, item, itemSum));
      } else if (i === houseHeadCount) {
        tableLines.push(`... и еще ${householdItems.length - houseHeadCount - houseTailCount} поз. (см. в Mini App) ...`);
      }
    }

    calcTotal = kitchenSum + houseSum;
    tableLines.push('──────────────────────────────────────────────');
    tableLines.push(`   Подытог Хоз склад:           ${Math.round(houseSum).toString().padStart(8, ' ')}`);
    tableLines.push('══════════════════════════════════════════════');
    tableLines.push(`   ОБЩИЙ ИТОГ:                  ${Math.round(calcTotal).toString().padStart(8, ' ')}`);
  } else {
    // Single Monospace Table
    tableLines.push('#  Наименование        Кол-во     Цена   Сумма');
    tableLines.push('──────────────────────────────────────────────');

    const shouldCompact = data.items.length > 22;
    const headCount = shouldCompact ? 14 : data.items.length;
    const tailCount = shouldCompact ? 3 : 0;

    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i];
      const itemSum = item.sum || item.qty * item.price;
      calcTotal += itemSum;

      if (!shouldCompact || i < headCount || i >= data.items.length - tailCount) {
        tableLines.push(formatTableRow(i, item, itemSum));
      } else if (i === headCount) {
        tableLines.push(`... и еще ${data.items.length - headCount - tailCount} поз. (см. в Mini App) ...`);
      }
    }

    tableLines.push('──────────────────────────────────────────────');
    tableLines.push(`               ИТОГО:           ${Math.round(calcTotal).toString().padStart(8, ' ')}`);
  }

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
    const anomalyLines: string[] = ['🔍 <b>Внимание: проверка фасовки / тары:</b>'];
    for (const a of anomalies) {
      anomalyLines.push(`⚠️ <b>${escapeHtml(a.name)}</b>: ${escapeHtml(a.anomalyMessage || '')}`);
    }
    if (anomalies.length >= 2) {
      lines.push(`<blockquote expandable>\n${anomalyLines.join('\n')}\n</blockquote>`);
    } else {
      lines.push('\n' + anomalyLines.join('\n'));
    }
  }

  // Price history insights (excluding anomalies already reported if needed, or including trends)
  const changedPrices = comparison.priceComparisons.filter(c => (c.trend === 'up' || c.trend === 'down') && !c.isAnomaly);
  if (changedPrices.length > 0) {
    const priceLines: string[] = ['📊 <b>Сверка с предыдущими ценами:</b>'];
    for (const cp of changedPrices) {
      const uStr = cp.currentUnit ? `/${cp.currentUnit}` : '';
      if (cp.trend === 'up') {
        priceLines.push(
          `🔺 <b>${escapeHtml(cp.name)}</b>: <b>${cp.currentPrice} ₽${uStr}</b> (+${cp.deltaRub} ₽ / +${cp.deltaPercent}% к ${escapeHtml(cp.previousDate || 'прошлому разу')})`
        );
      } else if (cp.trend === 'down') {
        priceLines.push(
          `🔻 <b>${escapeHtml(cp.name)}</b>: <b>${cp.currentPrice} ₽${uStr}</b> (${cp.deltaRub} ₽ / ${cp.deltaPercent}% к ${escapeHtml(cp.previousDate || 'прошлому разу')})`
        );
      }
    }
    if (changedPrices.length >= 2) {
      lines.push(`<blockquote expandable>\n${priceLines.join('\n')}\n</blockquote>`);
    } else {
      lines.push('\n' + priceLines.join('\n'));
    }
  }

  // Model indicator
  if (data.model_used) {
    const isEscalated = data.model_used.includes('эскалация');
    const badge = isEscalated ? '⚡️' : '🤖';
    lines.push(`\n${badge} <i>Модель: ${escapeHtml(data.model_used)}</i>`);
  }

  return clampTelegramHtml(lines.join('\n'));
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
    ''
  ];

  if (stats.suppliers.length >= 3) {
    const suppLines = ['🚛 <b>Поставщики за сегодня:</b>'];
    for (const s of stats.suppliers) {
      suppLines.push(`• <b>${escapeHtml(s.supplier)}</b>: ${s.count} накл. на <b>${s.total.toLocaleString('ru-RU')} ₽</b>`);
    }
    lines.push(`<blockquote expandable>\n${suppLines.join('\n')}\n</blockquote>`);
  } else if (stats.suppliers.length > 0) {
    lines.push('🚛 <b>Поставщики за сегодня:</b>');
    for (const s of stats.suppliers) {
      lines.push(`• <b>${escapeHtml(s.supplier)}</b>: ${s.count} накл. на <b>${s.total.toLocaleString('ru-RU')} ₽</b>`);
    }
  }

  return lines.join('\n');
}
