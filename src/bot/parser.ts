import { InvoiceData, InvoiceItem, WarehouseType } from '../types/index.js';
import { classifyItemWarehouse, isHouseholdItemName } from '../workflow/warehouse-classifier.js';

export interface ParseEditResult {
  success: boolean;
  data?: InvoiceData;
  message: string;
  isDeterministicError?: boolean;
}

/**
 * Safely evaluates math expressions like "4*6.5", "1250/5", "10+2.5", "3*0.38"
 * using a deterministic recursive-descent parser (zero eval / new Function).
 */
export function evaluateMath(raw: string): number | null {
  const cleaned = raw.trim().replace(/\s+/g, '').replace(/,/g, '.');
  if (!cleaned || !/^[\d.+\-*/()]+$/.test(cleaned)) {
    return null;
  }

  // Tokenize
  const tokens: string[] = [];
  let i = 0;
  while (i < cleaned.length) {
    const ch = cleaned[i];
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '(' || ch === ')') {
      tokens.push(ch);
      i++;
    } else if ((ch >= '0' && ch <= '9') || ch === '.') {
      let numStr = '';
      let hasDot = false;
      while (i < cleaned.length && ((cleaned[i] >= '0' && cleaned[i] <= '9') || cleaned[i] === '.')) {
        if (cleaned[i] === '.') {
          if (hasDot) return null; // e.g. 1.2.3
          hasDot = true;
        }
        numStr += cleaned[i];
        i++;
      }
      tokens.push(numStr);
    } else {
      return null;
    }
  }

  let pos = 0;

  function peek(): string | undefined {
    return tokens[pos];
  }

  function consume(): string {
    return tokens[pos++];
  }

  function parseExpression(): number {
    let left = parseTerm();
    while (pos < tokens.length && (peek() === '+' || peek() === '-')) {
      const op = consume();
      const right = parseTerm();
      if (op === '+') {
        left += right;
      } else {
        left -= right;
      }
    }
    return left;
  }

  function parseTerm(): number {
    let left = parseFactor();
    while (pos < tokens.length && (peek() === '*' || peek() === '/')) {
      const op = consume();
      const right = parseFactor();
      if (op === '*') {
        left *= right;
      } else {
        if (right === 0) throw new Error('Division by zero');
        left /= right;
      }
    }
    return left;
  }

  function parseFactor(): number {
    if (pos >= tokens.length) throw new Error('Unexpected end');
    if (peek() === '+') {
      consume();
      return parseFactor();
    }
    if (peek() === '-') {
      consume();
      return -parseFactor();
    }
    return parsePrimary();
  }

  function parsePrimary(): number {
    const t = peek();
    if (!t) throw new Error('Unexpected end of expression');
    if (t === '(') {
      consume(); // '('
      const val = parseExpression();
      if (consume() !== ')') throw new Error('Expected )');
      return val;
    }
    const num = Number(consume());
    if (isNaN(num)) throw new Error('Invalid number');
    return num;
  }

  try {
    const val = parseExpression();
    if (pos !== tokens.length) return null;
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
 * Extracts and removes warehouse tags ([хоз], [кухня]) from raw item name,
 * returning clean name and detected/fallback warehouse.
 */
export function extractNameAndWarehouse(
  rawName: string,
  fallbackWarehouse?: WarehouseType
): { name: string; warehouse?: WarehouseType } {
  let cleanName = rawName.trim();
  let itemWh: WarehouseType | undefined;

  if (/\[\s*(хоз\S*|house\S*)\s*\]/i.test(cleanName)) {
    itemWh = 'household';
    cleanName = cleanName.replace(/\[\s*(хоз\S*|house\S*)\s*\]/i, '').trim();
  } else if (/\[\s*(кухн\S*|kitchen\S*)\s*\]/i.test(cleanName)) {
    itemWh = 'kitchen';
    cleanName = cleanName.replace(/\[\s*(кухн\S*|kitchen\S*)\s*\]/i, '').trim();
  } else if (isHouseholdItemName(cleanName)) {
    itemWh = 'household';
  } else if (fallbackWarehouse) {
    itemWh = fallbackWarehouse;
  }

  return { name: cleanName, warehouse: itemWh };
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
    const whTag = (item.warehouse && item.warehouse !== data.warehouse)
      ? ` [${item.warehouse === 'household' ? 'хоз' : 'кухня'}]`
      : '';
    lines.push(`${index + 1}. ${item.name}${whTag}: ${item.qty}${unitStr} * ${item.price}`);
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

  // If there are words before digits (e.g. "Оливки 1 бан" or "Томаты черри 4*6.5кг" or "Расходники [хоз] 1")
  const wordPrefixMatch = trimmed.match(/^([a-zа-яё\s"«»№\[\]]+?)\s+([\d(].*)$/i);
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
        return {
          success: false,
          isDeterministicError: true,
          message: `Строка #${idx + 1} не найдена. Всего в накладной строк: ${updated.items.length}. Проверьте номер в карточке выше.`
        };
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

    const whMatch = single.match(/^склад\s*[:\-–]\s*(.+)$/i);
    if (whMatch) {
      const val = whMatch[1].trim().toLowerCase();
      if (val.includes('хоз') || val.includes('house')) {
        const newWh: WarehouseType = 'household';
        updated.warehouse = newWh;
        for (const it of updated.items) {
          it.warehouse = newWh;
        }
        return { success: true, data: updated, message: `Склад изменен на «Хоз склад».` };
      } else if (val.includes('кухн') || val.includes('kitchen')) {
        const newWh: WarehouseType = 'kitchen';
        updated.warehouse = newWh;
        for (const it of updated.items) {
          it.warehouse = newWh;
        }
        return { success: true, data: updated, message: `Склад изменен на «Склад Кухня».` };
      } else {
        return {
          success: false,
          isDeterministicError: true,
          message: `Неизвестный склад «${whMatch[1].trim()}». Укажите «Склад: Кухня» или «Склад: Хоз».`
        };
      }
    }

    // 1b-2. Item warehouse command: e.g. "1: склад хоз", "1 склад кухня", "1 хоз", "1 кухня", "#1 - хоз", "1 - хоз"
    const whItemMatch = single.match(/^#?(\d+)[\s.:)\-–]+(?:склад\s+)?(кухня|хоз|хозсклад|kitchen|household)$/i);
    if (whItemMatch) {
      const idx = parseInt(whItemMatch[1], 10) - 1;
      if (idx < 0 || idx >= updated.items.length) {
        return {
          success: false,
          isDeterministicError: true,
          message: `Строка #${idx + 1} не найдена. Всего в накладной строк: ${updated.items.length}.`
        };
      }
      const val = whItemMatch[2].toLowerCase();
      const newWh: WarehouseType = (val.includes('хоз') || val.includes('house')) ? 'household' : 'kitchen';
      updated.items[idx].warehouse = newWh;
      return {
        success: true,
        data: updated,
        message: `🏭 Позиция #${idx + 1} «${updated.items[idx].name}» переведена на ${newWh === 'household' ? 'Хоз склад' : 'Склад Кухня'}.`
      };
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
        const { name: rawName, qtyStr } = splitNameAndQuantity(left);
        const parsedQty = parseQuantityAndUnit(qtyStr);

        if (rawName && parsedQty && totalSum !== null && parsedQty.qty > 0) {
          const { name, warehouse: itemWh } = extractNameAndWarehouse(rawName, updated.warehouse || 'kitchen');
          const price = Math.round((totalSum / parsedQty.qty) * 100) / 100;
          const unit = parsedQty.unit || 'шт';
          updated.items.push({ name, qty: parsedQty.qty, price, sum: totalSum, unit, warehouse: itemWh });
          return {
            success: true,
            data: updated,
            message: `➕ Добавлена строка #${updated.items.length}: «${name}» (${itemWh === 'household' ? 'Хоз' : 'Кухня'}) — ${parsedQty.qty} ${unit} по ${price} ₽ = ${totalSum} ₽.`
          };
        }
      }

      // Case B: "* price"
      const lastMultIdx = Math.max(rest.lastIndexOf('*'), rest.lastIndexOf('x'), rest.lastIndexOf('х'));
      if (lastMultIdx > 0) {
        const left = rest.slice(0, lastMultIdx).trim();
        const price = evaluateMath(rest.slice(lastMultIdx + 1));
        if (price !== null) {
          const { name: rawName, qtyStr } = splitNameAndQuantity(left);
          const parsedQty = parseQuantityAndUnit(qtyStr);
          if (rawName && parsedQty && parsedQty.qty > 0) {
            const { name, warehouse: itemWh } = extractNameAndWarehouse(rawName, updated.warehouse || 'kitchen');
            const sum = Math.round(parsedQty.qty * price * 100) / 100;
            const unit = parsedQty.unit || 'шт';
            updated.items.push({ name, qty: parsedQty.qty, price, sum, unit, warehouse: itemWh });
            return {
              success: true,
              data: updated,
              message: `➕ Добавлена строка #${updated.items.length}: «${name}» (${itemWh === 'household' ? 'Хоз' : 'Кухня'}) — ${parsedQty.qty} ${unit} по ${price} ₽ = ${sum} ₽.`
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
          const { name: rawName, qtyStr } = splitNameAndQuantity(left);
          const parsedQty = parseQuantityAndUnit(qtyStr);
          if (rawName && parsedQty && parsedQty.qty > 0) {
            const { name, warehouse: itemWh } = extractNameAndWarehouse(rawName, updated.warehouse || 'kitchen');
            const sum = Math.round(parsedQty.qty * price * 100) / 100;
            const unit = parsedQty.unit || 'шт';
            updated.items.push({ name, qty: parsedQty.qty, price, sum, unit, warehouse: itemWh });
            return {
              success: true,
              data: updated,
              message: `➕ Добавлена строка #${updated.items.length}: «${name}» (${itemWh === 'household' ? 'Хоз' : 'Кухня'}) — ${parsedQty.qty} ${unit} по ${price} ₽ = ${sum} ₽.`
            };
          }
        }
      }

      return {
        success: false,
        isDeterministicError: true,
        message: rest
          ? `Чтобы добавить «${rest}», укажите количество и цену. Например: «+ ${rest} 5 * 180» или «+ ${rest} 5 180».`
          : 'Для добавления позиции укажите название, количество и цену. Например: «+ Томаты 5 * 180» или «+ Томаты 5 180».'
      };
    }

    // 1d. Edit single item by index: e.g. "1: 15 * 600", "1: 4*6.5кг * 250", "1: 380г = 180", "1: Оливки 1 бан * 180"
    const lineIdxMatch = single.match(/^(\d+)[\s.:)]+(.*)$/);
    if (lineIdxMatch) {
      const idx = parseInt(lineIdxMatch[1], 10) - 1;
      if (idx < 0 || idx >= updated.items.length) {
        return {
          success: false,
          isDeterministicError: true,
          message: `Строка #${idx + 1} не найдена. Всего в накладной строк: ${updated.items.length}.`
        };
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
            const extracted = extractNameAndWarehouse(name);
            updated.items[idx].name = extracted.name;
            if (extracted.warehouse) {
              updated.items[idx].warehouse = extracted.warehouse;
            }
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
              const extracted = extractNameAndWarehouse(name);
              updated.items[idx].name = extracted.name;
              if (extracted.warehouse) {
                updated.items[idx].warehouse = extracted.warehouse;
              }
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
              const extracted = extractNameAndWarehouse(name);
              updated.items[idx].name = extracted.name;
              if (extracted.warehouse) {
                updated.items[idx].warehouse = extracted.warehouse;
              }
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

      return {
        success: false,
        isDeterministicError: true,
        message: `Для изменения строки #${idx + 1} («${updated.items[idx].name}») укажите количество и цену (например: «${idx + 1}: 15 * 600» или «${idx + 1} 15 600»).`
      };
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
        const { name: cleanName, warehouse: itemWh } = extractNameAndWarehouse(name, updated.warehouse || 'kitchen');
        const price = Math.round((totalSum / parsedQty.qty) * 100) / 100;
        newItems.push({
          name: cleanName,
          qty: parsedQty.qty,
          price,
          sum: totalSum,
          unit: parsedQty.unit || 'шт',
          warehouse: itemWh || 'kitchen'
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
          const { name: cleanName, warehouse: itemWh } = extractNameAndWarehouse(name, updated.warehouse || 'kitchen');
          newItems.push({
            name: cleanName,
            qty: parsedQty.qty,
            price,
            sum: Math.round(parsedQty.qty * price * 100) / 100,
            unit: parsedQty.unit || 'шт',
            warehouse: itemWh || 'kitchen'
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
      'Не удалось распознать формат команды.\n\n' +
      'Примеры команд:\n' +
      '• 1: 15 * 600 — изменить строку 1 (кол-во * цена)\n' +
      '• 1 15 600 — короткий формат (строка кол-во цена)\n' +
      '• 1: 4*6.5кг * 250 — формула веса (4 кор. по 6.5 кг)\n' +
      '• 1: 18.5кг = 7400 — расчет цены из общей суммы\n' +
      '• 1: 380г = 180 — автоматический перевод грамм в кг\n' +
      '• 1 склад хоз — перевести строку на Хоз склад\n' +
      '• удалить 2 — удалить строку 2\n' +
      '• + Сыр 2 * 350 — добавить позицию\n' +
      '• поставщик: Название — сменить поставщика'
  };
}
