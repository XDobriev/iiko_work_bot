import { InvoiceData, InvoiceItem } from '../types/index.js';

export interface ParseEditResult {
  success: boolean;
  data?: InvoiceData;
  message: string;
}

/**
 * Safely evaluates math expressions like "4*6.5", "1250/5", "10+2.5", "3*0.38"
 */
export function evaluateMath(raw: string): number | null {
  const cleaned = raw.trim().replace(/\s+/g, '').replace(/,/g, '.');
  if (!/^[\d.+\-*/()]+$/.test(cleaned)) {
    return null;
  }
  try {
    const fn = new Function(`return (${cleaned});`);
    const val = Number(fn());
    return isNaN(val) || !isFinite(val) ? null : Math.round(val * 1000) / 1000;
  } catch {
    return null;
  }
}

/**
 * Parses quantity and extracts unit/grams.
 * Examples:
 *   "380г" -> { qty: 0.38, unit: "кг" }
 *   "15кг" -> { qty: 15, unit: "кг" }
 *   "4*6.5кг" -> { qty: 26, unit: "кг" }
 *   "1бан" -> { qty: 1, unit: "бан" }
 *   "5уп" -> { qty: 5, unit: "уп" }
 *   "20л" -> { qty: 20, unit: "л" }
 *   "10" -> { qty: 10, unit: undefined }
 */
export function parseQuantityAndUnit(raw: string): { qty: number; unit?: string } | null {
  const trimmed = raw.trim().replace(/,/g, '.');

  // Check for grams: e.g. "380г", "380гр", "380g", "4*380г"
  const gramMatch = trimmed.match(/^([\d.+\-*/()]+)\s*(?:г|гр|g)$/i);
  if (gramMatch) {
    const mathVal = evaluateMath(gramMatch[1]);
    if (mathVal !== null && mathVal > 0) {
      // Auto-convert grams to kg
      return { qty: Math.round((mathVal / 1000) * 1000) / 1000, unit: 'кг' };
    }
  }

  // Check for other units attached: "15кг", "1бан", "5уп", "20л", "10шт", "3бут", "4ящ"
  const unitMatch = trimmed.match(/^([\d.+\-*/()]+)\s*([a-zа-яё]+)?$/i);
  if (unitMatch) {
    const mathVal = evaluateMath(unitMatch[1]);
    if (mathVal !== null && mathVal > 0) {
      let unit = unitMatch[2]?.toLowerCase();
      if (unit) {
        if (unit.startsWith('кг') || unit === 'kg') unit = 'кг';
        else if (unit.startsWith('шт') || unit === 'pcs') unit = 'шт';
        else if (unit.startsWith('бан')) unit = 'бан';
        else if (unit.startsWith('бут')) unit = 'бут';
        else if (unit.startsWith('уп') || unit.startsWith('пач')) unit = 'уп';
        else if (unit.startsWith('л') || unit === 'l') unit = 'л';
        else if (unit.startsWith('ящ')) unit = 'ящ';
        else if (unit.startsWith('г') || unit === 'g') {
          return { qty: Math.round((mathVal / 1000) * 1000) / 1000, unit: 'кг' };
        }
      }
      return { qty: mathVal, unit };
    }
  }

  return null;
}

/**
 * Formats invoice into a compact, easily readable and editable text block.
 * When rendered in <code> in Telegram, a single click/tap copies it to clipboard.
 */
export function formatEditableInvoice(data: InvoiceData): string {
  const lines: string[] = [];
  lines.push(`Поставщик: ${data.supplier || 'Не указан'}`);
  lines.push(`Дата: ${data.date || new Date().toISOString().slice(0, 10)}`);
  lines.push(`Склад: ${data.warehouse === 'household' ? 'Хоз' : 'Кухня'}`);

  data.items.forEach((item, index) => {
    const unitStr = item.unit ? ` ${item.unit}` : '';
    lines.push(`${index + 1}. ${item.name}: ${item.qty}${unitStr} * ${item.price}`);
  });

  return lines.join('\n');
}

/**
 * Splits an expression containing quantity (and optional name) into name and quantity string.
 * Examples:
 *   "Оливки 1 бан" -> { name: "Оливки", qtyStr: "1 бан" }
 *   "Оливки: 1 бан" -> { name: "Оливки", qtyStr: "1 бан" }
 *   "4*6.5кг" -> { qtyStr: "4*6.5кг" }
 *   "1 бан" -> { qtyStr: "1 бан" }
 *   "15" -> { qtyStr: "15" }
 */
export function splitNameAndQuantity(str: string): { name?: string; qtyStr: string } {
  const trimmed = str.trim();

  // If there's an explicit separator like ':' or '-' or '–'
  const colonMatch = trimmed.match(/^(.+?)[\s]*[:\-–]\s*([\d(].*)$/);
  if (colonMatch) {
    return { name: colonMatch[1].trim(), qtyStr: colonMatch[2].trim() };
  }

  // If there are words before digits (e.g. "Оливки 1 бан" or "Томаты черри 4*6.5кг")
  const wordPrefixMatch = trimmed.match(/^([a-zа-яё\s"«»№]+?)\s+([\d(].*)$/i);
  if (wordPrefixMatch) {
    return { name: wordPrefixMatch[1].trim(), qtyStr: wordPrefixMatch[2].trim() };
  }

  return { qtyStr: trimmed };
}

/**
 * Parses user edit input: supports formulas ("4*6.5"), "= total" syntax,
 * unit conversions (grams -> kg, cans, packs), deletions, and full text paste.
 */
export function parseInvoiceEditText(rawText: string, current: InvoiceData): ParseEditResult {
  const text = rawText.trim();
  if (!text) {
    return { success: false, message: 'Пустой ввод. Отправьте строку с правкой или обновленный список.' };
  }

  // Clone current data
  const updated: InvoiceData = {
    date: current.date,
    supplier: current.supplier,
    warehouse: current.warehouse,
    items: current.items.map(it => ({ ...it })),
    total_written: current.total_written
  };

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // 1. Single-line command checks
  if (lines.length === 1) {
    const single = lines[0];

    // 1a. Delete command: "удалить 2", "удали 2", "del 2", "- 2", "-2"
    const delMatch = single.match(/^(?:удалить|удали|del|-)\s*(\d+)$/i);
    if (delMatch) {
      const idx = parseInt(delMatch[1], 10) - 1;
      if (idx < 0 || idx >= updated.items.length) {
        return { success: false, message: `Строка #${idx + 1} не найдена. Всего строк: ${updated.items.length}.` };
      }
      const removed = updated.items.splice(idx, 1)[0];
      return {
        success: true,
        data: updated,
        message: `🗑 Удалена позиция #${idx + 1}: «${removed.name}».`
      };
    }

    // 1b. Metadata commands
    const supMatch = single.match(/^поставщик\s*[:\-–]\s*(.+)$/i);
    if (supMatch) {
      updated.supplier = supMatch[1].trim();
      return { success: true, data: updated, message: `Поставщик изменен на «${updated.supplier}».` };
    }

    const dateMatch = single.match(/^дата\s*[:\-–]\s*([\d.]+)/i);
    if (dateMatch) {
      updated.date = dateMatch[1].trim();
      return { success: true, data: updated, message: `Дата изменена на «${updated.date}».` };
    }

    const whMatch = single.match(/^склад\s*[:\-–]\s*(кухня|хоз|хозсклад|kitchen|household)/i);
    if (whMatch) {
      const val = whMatch[1].toLowerCase();
      updated.warehouse = (val.includes('хоз') || val.includes('house')) ? 'household' : 'kitchen';
      return { success: true, data: updated, message: `Склад изменен на «${updated.warehouse === 'household' ? 'Хоз склад' : 'Склад Кухня'}».` };
    }

    // 1c. Add command: "+ Томаты 4*6.5кг * 150" or "+ Оливки 1бан = 180" or "добавить Сыр 1.2кг * 500"
    const addMatch = single.match(/^(?:\+|\bдобавить\b)\s*(.*)$/i);
    if (addMatch) {
      const rest = addMatch[1].trim();

      // Case A: "= totalSum"
      const equalIdx = rest.lastIndexOf('=');
      if (equalIdx > 0) {
        const left = rest.slice(0, equalIdx).trim();
        const totalSum = evaluateMath(rest.slice(equalIdx + 1));
        const { name, qtyStr } = splitNameAndQuantity(left);
        const parsedQty = parseQuantityAndUnit(qtyStr);

        if (name && parsedQty && totalSum !== null && parsedQty.qty > 0) {
          const price = Math.round((totalSum / parsedQty.qty) * 100) / 100;
          const unit = parsedQty.unit || 'шт';
          updated.items.push({ name, qty: parsedQty.qty, price, sum: totalSum, unit });
          return {
            success: true,
            data: updated,
            message: `➕ Добавлена строка #${updated.items.length}: «${name}» — ${parsedQty.qty} ${unit} по ${price} ₽ = ${totalSum} ₽.`
          };
        }
      }

      // Case B: "* price"
      const lastMultIdx = Math.max(rest.lastIndexOf('*'), rest.lastIndexOf('x'), rest.lastIndexOf('х'));
      if (lastMultIdx > 0) {
        const left = rest.slice(0, lastMultIdx).trim();
        const price = evaluateMath(rest.slice(lastMultIdx + 1));
        if (price !== null) {
          const { name, qtyStr } = splitNameAndQuantity(left);
          const parsedQty = parseQuantityAndUnit(qtyStr);
          if (name && parsedQty && parsedQty.qty > 0) {
            const sum = Math.round(parsedQty.qty * price * 100) / 100;
            const unit = parsedQty.unit || 'шт';
            updated.items.push({ name, qty: parsedQty.qty, price, sum, unit });
            return {
              success: true,
              data: updated,
              message: `➕ Добавлена строка #${updated.items.length}: «${name}» — ${parsedQty.qty} ${unit} по ${price} ₽ = ${sum} ₽.`
            };
          }
        }
      }

      // Case C: space-separated "name qty price"
      const lastSpaceIdx = rest.lastIndexOf(' ');
      if (lastSpaceIdx > 0) {
        const price = evaluateMath(rest.slice(lastSpaceIdx + 1));
        if (price !== null) {
          const left = rest.slice(0, lastSpaceIdx).trim();
          const { name, qtyStr } = splitNameAndQuantity(left);
          const parsedQty = parseQuantityAndUnit(qtyStr);
          if (name && parsedQty && parsedQty.qty > 0) {
            const sum = Math.round(parsedQty.qty * price * 100) / 100;
            const unit = parsedQty.unit || 'шт';
            updated.items.push({ name, qty: parsedQty.qty, price, sum, unit });
            return {
              success: true,
              data: updated,
              message: `➕ Добавлена строка #${updated.items.length}: «${name}» — ${parsedQty.qty} ${unit} по ${price} ₽ = ${sum} ₽.`
            };
          }
        }
      }
    }

    // 1d. Edit single item by index: e.g. "1: 15 * 600", "1: 4*6.5кг * 250", "1: 380г = 180", "1: Оливки 1 бан * 180"
    const lineIdxMatch = single.match(/^(\d+)[\s.:)]+(.*)$/);
    if (lineIdxMatch) {
      const idx = parseInt(lineIdxMatch[1], 10) - 1;
      if (idx < 0 || idx >= updated.items.length) {
        return { success: false, message: `Строка #${idx + 1} не найдена. Всего строк: ${updated.items.length}.` };
      }

      const rest = lineIdxMatch[2].trim();

      // Case A: "= totalSum" (e.g. "1: 380г = 180" or "1: 18.5кг = 7400")
      const equalIdx = rest.lastIndexOf('=');
      if (equalIdx > 0) {
        const left = rest.slice(0, equalIdx).trim();
        const totalSum = evaluateMath(rest.slice(equalIdx + 1));
        const { name, qtyStr } = splitNameAndQuantity(left);
        const parsedQty = parseQuantityAndUnit(qtyStr);

        if (parsedQty && totalSum !== null && parsedQty.qty > 0) {
          if (name && name.length > 1) {
            updated.items[idx].name = name;
          }
          const price = Math.round((totalSum / parsedQty.qty) * 100) / 100;
          updated.items[idx].qty = parsedQty.qty;
          updated.items[idx].price = price;
          updated.items[idx].sum = totalSum;
          if (parsedQty.unit) {
            updated.items[idx].unit = parsedQty.unit;
          }

          const unitDisplay = updated.items[idx].unit ? ` ${updated.items[idx].unit}` : '';
          return {
            success: true,
            data: updated,
            message: `✏️ Строка #${idx + 1} обновлена: «${updated.items[idx].name}» — ${parsedQty.qty}${unitDisplay} по ${price} ₽ = ${totalSum} ₽.`
          };
        }
      }

      // Case B: "* price" (e.g. "1: 4*6.5кг * 250" or "1: Оливки 1 бан * 180" or "1: 15 * 600")
      const lastMultIdx = Math.max(rest.lastIndexOf('*'), rest.lastIndexOf('x'), rest.lastIndexOf('х'));
      if (lastMultIdx > 0) {
        const left = rest.slice(0, lastMultIdx).trim();
        const price = evaluateMath(rest.slice(lastMultIdx + 1));

        if (price !== null) {
          const { name, qtyStr } = splitNameAndQuantity(left);
          const parsedQty = parseQuantityAndUnit(qtyStr);

          if (parsedQty && parsedQty.qty > 0) {
            if (name && name.length > 1) {
              updated.items[idx].name = name;
            }
            updated.items[idx].qty = parsedQty.qty;
            updated.items[idx].price = price;
            updated.items[idx].sum = Math.round(parsedQty.qty * price * 100) / 100;
            if (parsedQty.unit) {
              updated.items[idx].unit = parsedQty.unit;
            }

            const unitDisplay = updated.items[idx].unit ? ` ${updated.items[idx].unit}` : '';
            return {
              success: true,
              data: updated,
              message: `✏️ Строка #${idx + 1} обновлена: «${updated.items[idx].name}» — ${parsedQty.qty}${unitDisplay} по ${price} ₽ = ${updated.items[idx].sum} ₽.`
            };
          }
        }
      }

      // Case C: space-separated "qty price" (e.g. "1: 15 600" or "1: 1.5кг 400")
      const lastSpaceIdx = rest.lastIndexOf(' ');
      if (lastSpaceIdx > 0) {
        const price = evaluateMath(rest.slice(lastSpaceIdx + 1));
        if (price !== null) {
          const left = rest.slice(0, lastSpaceIdx).trim();
          const { name, qtyStr } = splitNameAndQuantity(left);
          const parsedQty = parseQuantityAndUnit(qtyStr);

          if (parsedQty && parsedQty.qty > 0) {
            if (name && name.length > 1) {
              updated.items[idx].name = name;
            }
            updated.items[idx].qty = parsedQty.qty;
            updated.items[idx].price = price;
            updated.items[idx].sum = Math.round(parsedQty.qty * price * 100) / 100;
            if (parsedQty.unit) {
              updated.items[idx].unit = parsedQty.unit;
            }

            const unitDisplay = updated.items[idx].unit ? ` ${updated.items[idx].unit}` : '';
            return {
              success: true,
              data: updated,
              message: `✏️ Строка #${idx + 1} обновлена: «${updated.items[idx].name}» — ${parsedQty.qty}${unitDisplay} по ${price} ₽ = ${updated.items[idx].sum} ₽.`
            };
          }
        }
      }
    }
  }

  // 2. Full or multi-line text paste
  const newItems: InvoiceItem[] = [];
  let foundAnyItem = false;

  for (const line of lines) {
    // Check metadata in multi-line paste
    const sMatch = line.match(/^поставщик\s*[:\-–]\s*(.+)$/i);
    if (sMatch) {
      updated.supplier = sMatch[1].trim();
      continue;
    }
    const dMatch = line.match(/^дата\s*[:\-–]\s*([\d.]+)/i);
    if (dMatch) {
      updated.date = dMatch[1].trim();
      continue;
    }
    const wMatch = line.match(/^склад\s*[:\-–]\s*(кухня|хоз|хозсклад|kitchen|household)/i);
    if (wMatch) {
      const val = wMatch[1].toLowerCase();
      updated.warehouse = (val.includes('хоз') || val.includes('house')) ? 'household' : 'kitchen';
      continue;
    }

    // Strip leading index if present (e.g. "1. " or "1) ")
    const lineWithoutNum = line.replace(/^\d+[\s.:)]+\s*/, '').trim();

    // Check if line has "= total" syntax: e.g. "Оливки: 1 бан = 180" or "Сыр: 1.2 = 600"
    const equalIdx = lineWithoutNum.lastIndexOf('=');
    if (equalIdx > 0) {
      const left = lineWithoutNum.slice(0, equalIdx).trim();
      const totalSum = evaluateMath(lineWithoutNum.slice(equalIdx + 1));
      const { name, qtyStr } = splitNameAndQuantity(left);
      const parsedQty = parseQuantityAndUnit(qtyStr);

      if (name && parsedQty && totalSum !== null && parsedQty.qty > 0) {
        const price = Math.round((totalSum / parsedQty.qty) * 100) / 100;
        newItems.push({
          name,
          qty: parsedQty.qty,
          price,
          sum: totalSum,
          unit: parsedQty.unit || 'шт'
        });
        foundAnyItem = true;
        continue;
      }
    }

    // Check if line has "* price" syntax: e.g. "Говядина: 12 кг * 600" or "Оливки 1 бан * 180"
    const lastMultIdx = Math.max(lineWithoutNum.lastIndexOf('*'), lineWithoutNum.lastIndexOf('x'), lineWithoutNum.lastIndexOf('х'));
    if (lastMultIdx > 0) {
      const left = lineWithoutNum.slice(0, lastMultIdx).trim();
      let right = lineWithoutNum.slice(lastMultIdx + 1).trim();
      if (right.includes('=')) {
        right = right.split('=')[0].trim();
      }
      const price = evaluateMath(right);
      if (price !== null) {
        const { name, qtyStr } = splitNameAndQuantity(left);
        const parsedQty = parseQuantityAndUnit(qtyStr);
        if (name && parsedQty && parsedQty.qty > 0) {
          newItems.push({
            name,
            qty: parsedQty.qty,
            price,
            sum: Math.round(parsedQty.qty * price * 100) / 100,
            unit: parsedQty.unit || 'шт'
          });
          foundAnyItem = true;
          continue;
        }
      }
    }
  }

  if (foundAnyItem && newItems.length > 0) {
    updated.items = newItems;
    return {
      success: true,
      data: updated,
      message: `✅ Накладная успешно обновлена (${newItems.length} позиций).`
    };
  }

  return {
    success: false,
    message:
      'Не удалось распознать формат строки.\n\n' +
      'Примеры команд и формул:\n' +
      '• <code>1: 15кг * 600</code> — кол-во, единица и цена\n' +
      '• <code>1: 4*6.5кг * 250</code> — формула (4 коробки по 6.5 кг)\n' +
      '• <code>1: 18.5кг = 7400</code> — расчет цены по общему весу и сумме\n' +
      '• <code>1: 380г = 180</code> — перевод грамм в кг (0.38 кг = 180 ₽)\n' +
      '• <code>1: 1бан * 180</code> — фиксация тары (банка, пачка, штука)\n' +
      '• <code>удалить 2</code> — удалить строку 2\n' +
      '• <code>+ Зелень 5 * 80</code> — добавить новую строку'
  };
}
