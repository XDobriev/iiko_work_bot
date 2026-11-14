import { DatabaseSync } from 'node:sqlite';
import { getDatabase } from './database.js';
import {
  InvoiceData,
  InvoiceItem,
  InvoiceRecord,
  InvoiceItemRecord,
  InvoiceDomainRecord,
  ProductMappingRecord,
  InvoiceStatus,
  HistoricalComparison,
  PriceComparisonItem,
  WarehouseType
} from '../types/index.js';

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'()[\],.:;!?-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SaveInvoiceMeta {
  userId?: number;
  messageId?: number;
  photoFileId?: string;
  localPhotoPath?: string;
  restaurantId?: string;
}

export interface DailyStats {
  date: string;
  totalInvoices: number;
  totalSpend: number;
  kitchenSpend: number;
  householdSpend: number;
  supplierCount: number;
  suppliers: Array<{ supplier: string; count: number; total: number }>;
}

export class InvoicesRepository {
  private db: DatabaseSync;

  constructor(customDb?: DatabaseSync) {
    this.db = customDb || getDatabase();
  }

  /**
   * Saves invoice and all its items in a single transaction.
   */
  saveInvoice(
    data: InvoiceData,
    meta?: SaveInvoiceMeta
  ): { invoiceId: number; totalCalculated: number } {
    let totalCalculated = 0;
    for (const item of data.items) {
      const sum = item.sum || item.qty * item.price;
      totalCalculated += sum;
    }

    const insertInvoice = this.db.prepare(`
      INSERT INTO invoices (
        restaurant_id, date, supplier, warehouse, total_calculated, total_written,
        status, telegram_user_id, telegram_message_id, photo_file_id, local_photo_path, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    `);

    const result = insertInvoice.run(
      meta?.restaurantId || 'beyni',
      data.date || new Date().toISOString().slice(0, 10),
      data.supplier || 'Не указан',
      data.warehouse || 'kitchen',
      totalCalculated,
      data.total_written ?? null,
      meta?.userId ?? null,
      meta?.messageId ?? null,
      meta?.photoFileId ?? null,
      meta?.localPhotoPath ?? null,
      JSON.stringify(data)
    );

    const invoiceId = Number(result.lastInsertRowid);

    const insertItem = this.db.prepare(`
      INSERT INTO invoice_items (
        invoice_id, name, normalized_name, qty, price, sum, unit
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of data.items) {
      const sum = item.sum || item.qty * item.price;
      insertItem.run(
        invoiceId,
        item.name,
        normalizeName(item.name),
        item.qty,
        item.price,
        sum,
        item.unit || 'шт'
      );
    }

    return { invoiceId, totalCalculated };
  }

  /**
   * Returns a complete domain record with typed InvoiceData, DB header, and items.
   */
  getInvoice(id: number): InvoiceDomainRecord | null {
    const invStmt = this.db.prepare('SELECT * FROM invoices WHERE id = ?');
    const invoice = invStmt.get(id) as unknown as (InvoiceRecord & { local_photo_path?: string; raw_json?: string }) | undefined;
    if (!invoice) return null;

    const itemsStmt = this.db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id ASC');
    const items = itemsStmt.all(id) as unknown as InvoiceItemRecord[];

    const data: InvoiceData = {
      date: invoice.date || '',
      supplier: invoice.supplier || 'Не указан',
      warehouse: invoice.warehouse || 'kitchen',
      items: items.map(it => ({
        name: it.name,
        qty: it.qty,
        price: it.price,
        sum: it.sum,
        unit: it.unit || undefined
      })),
      total_written: invoice.total_written ?? null
    };

    return {
      invoice,
      items,
      data
    };
  }

  getInvoiceData(id: number): InvoiceData | null {
    const domain = this.getInvoice(id);
    return domain ? domain.data : null;
  }

  getInvoiceById(id: number): { invoice: InvoiceRecord & { local_photo_path?: string }; items: InvoiceItemRecord[] } | null {
    const domain = this.getInvoice(id);
    if (!domain) return null;
    return { invoice: domain.invoice, items: domain.items };
  }

  updateInvoiceData(id: number, data: InvoiceData): boolean {
    let totalCalculated = 0;
    for (const item of data.items) {
      const sum = item.sum || item.qty * item.price;
      totalCalculated += sum;
    }

    const updateStmt = this.db.prepare(`
      UPDATE invoices
      SET supplier = ?, date = ?, warehouse = ?, total_calculated = ?, total_written = ?, raw_json = ?
      WHERE id = ?
    `);
    const res = updateStmt.run(
      data.supplier || 'Не указан',
      data.date || new Date().toISOString().slice(0, 10),
      data.warehouse || 'kitchen',
      totalCalculated,
      data.total_written ?? null,
      JSON.stringify(data),
      id
    );

    if (res.changes === 0) return false;

    // Replace items
    this.db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(id);

    const insertItem = this.db.prepare(`
      INSERT INTO invoice_items (
        invoice_id, name, normalized_name, qty, price, sum, unit
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of data.items) {
      const sum = item.sum || item.qty * item.price;
      insertItem.run(
        id,
        item.name,
        normalizeName(item.name),
        item.qty,
        item.price,
        sum,
        item.unit || 'шт'
      );
    }

    return true;
  }

  updateInvoiceStatus(id: number, status: InvoiceStatus, iikoDocumentId?: string): boolean {
    const stmt = this.db.prepare(`
      UPDATE invoices
      SET status = ?, iiko_document_id = COALESCE(?, iiko_document_id)
      WHERE id = ?
    `);
    const res = stmt.run(status, iikoDocumentId ?? null, id);
    return res.changes > 0;
  }

  updateLocalPhotoPath(id: number, photoPath: string): boolean {
    const stmt = this.db.prepare('UPDATE invoices SET local_photo_path = ? WHERE id = ?');
    const res = stmt.run(photoPath, id);
    return res.changes > 0;
  }

  toggleWarehouse(id: number): WarehouseType | null {
    const inv = this.getInvoiceById(id);
    if (!inv) return null;

    const newWarehouse: WarehouseType = inv.invoice.warehouse === 'household' ? 'kitchen' : 'household';
    const stmt = this.db.prepare('UPDATE invoices SET warehouse = ? WHERE id = ?');
    stmt.run(newWarehouse, id);
    return newWarehouse;
  }

  /**
   * Enhanced duplicate detection: checks if an invoice with same supplier and date exists,
   * comparing item composition and totals to distinguish separate deliveries from actual duplicates.
   */
  checkDuplicate(data: InvoiceData, restaurantId = 'beyni'): { isDuplicate: boolean; duplicateInvoiceId?: number; duplicateDate?: string } {
    if (!data.supplier || data.supplier === 'Не указан') {
      return { isDuplicate: false };
    }

    const currentNormSupplier = normalizeName(data.supplier);
    const currentTotal = data.items.reduce((acc, it) => acc + (it.sum || it.qty * it.price), 0);
    const currentNormNames = new Set(data.items.map(it => normalizeName(it.name)));

    const stmt = this.db.prepare(`
      SELECT id, supplier, date, total_calculated, total_written
      FROM invoices
      WHERE restaurant_id = ? AND status != 'rejected'
      ORDER BY id DESC LIMIT 50
    `);

    const allCandidates = stmt.all(restaurantId) as Array<{
      id: number;
      supplier: string;
      date: string;
      total_calculated: number;
      total_written: number | null;
    }>;

    // Filter by normalized supplier in JavaScript (handles Unicode/Cyrillic casing and punctuation)
    const candidates = allCandidates.filter(c => normalizeName(c.supplier) === currentNormSupplier);

    const itemsStmt = this.db.prepare(`
      SELECT normalized_name, qty, price, sum
      FROM invoice_items
      WHERE invoice_id = ?
    `);

    for (const cand of candidates) {
      const isSameDate = cand.date === data.date;
      const totalDiff = Math.abs(cand.total_calculated - currentTotal);
      const isTotalIdentical = totalDiff < 2;
      const isWrittenIdentical = cand.total_written != null && data.total_written != null && Math.abs(cand.total_written - data.total_written) < 2;

      const candItems = itemsStmt.all(cand.id) as Array<{
        normalized_name: string;
        qty: number;
        price: number;
        sum: number;
      }>;

      let matchedItemsCount = 0;
      for (const ci of candItems) {
        if (currentNormNames.has(ci.normalized_name)) {
          matchedItemsCount++;
        }
      }

      const totalItems = Math.max(candItems.length, data.items.length);
      const itemOverlapRatio = totalItems > 0 ? matchedItemsCount / totalItems : 1;

      // Distinct deliveries: if both have items but zero items overlap, they are not duplicates
      if (candItems.length > 0 && data.items.length > 0 && matchedItemsCount === 0) {
        continue;
      }

      // 1. Same date and identical total with non-zero item overlap (or both have no items)
      if (isSameDate && (isTotalIdentical || isWrittenIdentical) && (itemOverlapRatio >= 0.3 || totalItems === 0)) {
        return {
          isDuplicate: true,
          duplicateInvoiceId: cand.id,
          duplicateDate: cand.date
        };
      }

      // 2. Same date and high item overlap (>= 70%)
      if (isSameDate && itemOverlapRatio >= 0.7) {
        return {
          isDuplicate: true,
          duplicateInvoiceId: cand.id,
          duplicateDate: cand.date
        };
      }

      // 3. Both have 0 items on same date
      if (isSameDate && candItems.length === 0 && data.items.length === 0) {
        return {
          isDuplicate: true,
          duplicateInvoiceId: cand.id,
          duplicateDate: cand.date
        };
      }

      // 4. Same supplier, identical total AND high item overlap (>= 80%) across nearby dates
      if (!isSameDate && isTotalIdentical && itemOverlapRatio >= 0.8 && data.items.length > 0) {
        return {
          isDuplicate: true,
          duplicateInvoiceId: cand.id,
          duplicateDate: cand.date
        };
      }
    }

    return { isDuplicate: false };
  }

  /**
   * Compares each item with previous prices in history and detects unit/packaging anomalies.
   */
  compareWithHistory(data: InvoiceData, restaurantId = 'beyni'): HistoricalComparison {
    const dup = this.checkDuplicate(data, restaurantId);
    const priceComparisons: PriceComparisonItem[] = [];
    let totalPriceDelta = 0;
    let totalCalculated = 0;

    const findPriceStmt = this.db.prepare(`
      SELECT ii.price, ii.unit, i.date, i.supplier
      FROM invoice_items ii
      JOIN invoices i ON ii.invoice_id = i.id
      WHERE ii.normalized_name = ? AND i.restaurant_id = ? AND i.status != 'rejected'
      ORDER BY i.id DESC LIMIT 1
    `);

    for (const item of data.items) {
      const sum = item.sum || item.qty * item.price;
      totalCalculated += sum;
      const normName = normalizeName(item.name);

      const prev = findPriceStmt.get(normName, restaurantId) as
        | { price: number; unit?: string; date: string; supplier: string }
        | undefined;

      if (prev && prev.price > 0) {
        const deltaRub = Math.round((item.price - prev.price) * 100) / 100;
        const deltaPercent = Math.round(((item.price - prev.price) / prev.price) * 1000) / 10;
        const totalDeltaForItem = deltaRub * item.qty;
        totalPriceDelta += totalDeltaForItem;

        let trend: 'up' | 'down' | 'same' = 'same';
        if (deltaRub > 0.01) trend = 'up';
        else if (deltaRub < -0.01) trend = 'down';

        let isAnomaly = false;
        let anomalyMessage: string | undefined;

        // Anti-shock anomaly check: if price changes by > 70% or < -50%
        if (deltaPercent >= 70 || deltaPercent <= -50) {
          isAnomaly = true;
          const prevUnitStr = prev.unit ? ` за ${prev.unit}` : '';
          const curUnitStr = item.unit ? ` за ${item.unit}` : '';
          anomalyMessage = `Аномальное изменение цены (${deltaPercent > 0 ? '+' : ''}${deltaPercent}%)! Возможно, изменилась фасовка или единица: в прошлой поставке было ${prev.price} ₽${prevUnitStr} (от ${prev.date}), сейчас ${item.price} ₽${curUnitStr}.`;
        } else if (prev.unit && item.unit && prev.unit.toLowerCase() !== item.unit.toLowerCase()) {
          isAnomaly = true;
          anomalyMessage = `Изменилась единица измерения: ранее было ${prev.unit}, сейчас указано ${item.unit}.`;
        }

        priceComparisons.push({
          name: item.name,
          currentPrice: item.price,
          currentQty: item.qty,
          currentSum: sum,
          currentUnit: item.unit,
          previousPrice: prev.price,
          previousDate: prev.date,
          previousUnit: prev.unit,
          deltaRub,
          deltaPercent,
          trend,
          isAnomaly,
          anomalyMessage
        });
      } else {
        priceComparisons.push({
          name: item.name,
          currentPrice: item.price,
          currentQty: item.qty,
          currentSum: sum,
          currentUnit: item.unit,
          previousPrice: null,
          previousDate: null,
          previousUnit: null,
          deltaRub: null,
          deltaPercent: null,
          trend: 'new'
        });
      }
    }

    let mathDiscrepancy = false;
    let discrepancyDiff = 0;
    if (data.total_written != null && data.total_written > 0) {
      discrepancyDiff = Math.round(Math.abs(data.total_written - totalCalculated) * 100) / 100;
      if (discrepancyDiff > 2) {
        mathDiscrepancy = true;
      }
    }

    return {
      isDuplicate: dup.isDuplicate,
      duplicateInvoiceId: dup.duplicateInvoiceId,
      duplicateDate: dup.duplicateDate,
      priceComparisons,
      totalPriceDelta: Math.round(totalPriceDelta * 100) / 100,
      mathDiscrepancy,
      discrepancyDiff
    };
  }

  // --- Product Mappings ---

  findProductMapping(rawName: string): { iikoProductName: string; iikoProductId?: string } | null {
    const norm = normalizeName(rawName);
    const stmt = this.db.prepare(`
      SELECT iiko_product_name, iiko_product_id
      FROM product_mappings
      WHERE raw_name = ? OR normalized_name = ?
      LIMIT 1
    `);
    const res = stmt.get(rawName.trim(), norm) as { iiko_product_name: string; iiko_product_id?: string | null } | undefined;
    if (!res) return null;
    return {
      iikoProductName: res.iiko_product_name,
      iikoProductId: res.iiko_product_id || undefined
    };
  }

  saveProductMapping(rawName: string, iikoProductName: string, iikoProductId?: string): void {
    const norm = normalizeName(rawName);
    const stmt = this.db.prepare(`
      INSERT INTO product_mappings (raw_name, normalized_name, iiko_product_name, iiko_product_id, updated_at)
      VALUES (?, ?, ?, ?, datetime('now', 'localtime'))
      ON CONFLICT(raw_name) DO UPDATE SET
        normalized_name = excluded.normalized_name,
        iiko_product_name = excluded.iiko_product_name,
        iiko_product_id = excluded.iiko_product_id,
        updated_at = datetime('now', 'localtime')
    `);
    stmt.run(rawName.trim(), norm, iikoProductName.trim(), iikoProductId || null);
  }

  deleteProductMapping(rawName: string): boolean {
    const stmt = this.db.prepare('DELETE FROM product_mappings WHERE raw_name = ? OR normalized_name = ?');
    const res = stmt.run(rawName.trim(), normalizeName(rawName));
    return res.changes > 0;
  }

  getAllProductMappings(): ProductMappingRecord[] {
    const stmt = this.db.prepare('SELECT * FROM product_mappings ORDER BY updated_at DESC');
    return stmt.all() as unknown as ProductMappingRecord[];
  }

  // --- Memory Context & Analytics ---

  getKnownItems(limit: number = 100, restaurantId = 'beyni'): string[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT ii.name
      FROM invoice_items ii
      JOIN invoices i ON ii.invoice_id = i.id
      WHERE i.restaurant_id = ?
      ORDER BY ii.id DESC LIMIT ?
    `);
    const rows = stmt.all(restaurantId, limit) as { name: string }[];
    return rows.map(r => r.name);
  }

  getKnownItemsWithUnits(limit: number = 80, restaurantId = 'beyni'): Array<{ name: string; unit?: string }> {
    const stmt = this.db.prepare(`
      SELECT ii.name, ii.unit, COUNT(*) as cnt
      FROM invoice_items ii
      JOIN invoices i ON ii.invoice_id = i.id
      WHERE i.restaurant_id = ? AND ii.name IS NOT NULL
      GROUP BY ii.name, ii.unit
      ORDER BY cnt DESC LIMIT ?
    `);
    const rows = stmt.all(restaurantId, limit) as Array<{ name: string; unit?: string }>;
    return rows.map(r => ({ name: r.name, unit: r.unit || undefined }));
  }

  getKnownSuppliers(limit: number = 50, restaurantId = 'beyni'): string[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT supplier
      FROM invoices
      WHERE restaurant_id = ? AND supplier != 'Не указан'
      ORDER BY id DESC LIMIT ?
    `);
    const rows = stmt.all(restaurantId, limit) as { supplier: string }[];
    return rows.map(r => r.supplier);
  }

  getRecentInvoices(limit: number = 10, restaurantId = 'beyni'): InvoiceRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM invoices
      WHERE restaurant_id = ?
      ORDER BY id DESC LIMIT ?
    `);
    return stmt.all(restaurantId, limit) as unknown as InvoiceRecord[];
  }

  getDailyStats(dateStr?: string, restaurantId = 'beyni'): DailyStats {
    const date = dateStr || new Date().toISOString().slice(0, 10);

    const invoicesStmt = this.db.prepare(`
      SELECT warehouse, total_calculated
      FROM invoices
      WHERE restaurant_id = ? AND (date = ? OR created_at LIKE ?) AND status != 'rejected'
    `);
    const invs = invoicesStmt.all(restaurantId, date, `${date}%`) as Array<{ warehouse: string; total_calculated: number }>;

    let totalSpend = 0;
    let kitchenSpend = 0;
    let householdSpend = 0;

    for (const inv of invs) {
      totalSpend += inv.total_calculated;
      if (inv.warehouse === 'household') {
        householdSpend += inv.total_calculated;
      } else {
        kitchenSpend += inv.total_calculated;
      }
    }

    const suppliersStmt = this.db.prepare(`
      SELECT supplier, COUNT(*) as count, SUM(total_calculated) as total
      FROM invoices
      WHERE restaurant_id = ? AND (date = ? OR created_at LIKE ?) AND status != 'rejected'
      GROUP BY supplier
      ORDER BY total DESC
    `);
    const suppliers = suppliersStmt.all(restaurantId, date, `${date}%`) as Array<{ supplier: string; count: number; total: number }>;

    return {
      date,
      totalInvoices: invs.length,
      totalSpend: Math.round(totalSpend),
      kitchenSpend: Math.round(kitchenSpend),
      householdSpend: Math.round(householdSpend),
      supplierCount: suppliers.length,
      suppliers
    };
  }

  exportCsv(limit = 100, restaurantId = 'beyni'): string {
    const stmt = this.db.prepare(`
      SELECT 
        i.id as invoice_id,
        i.date,
        i.supplier,
        i.warehouse,
        i.status,
        i.iiko_document_id,
        ii.name as item_name,
        ii.qty,
        ii.price,
        ii.sum
      FROM invoices i
      JOIN invoice_items ii ON i.id = ii.invoice_id
      WHERE i.restaurant_id = ?
      ORDER BY i.id DESC
      LIMIT ?
    `);

    const rows = stmt.all(restaurantId, limit) as any[];
    const headers = ['ID Накладной', 'Дата', 'Поставщик', 'Склад', 'Статус', '№ в iiko', 'Товар', 'Кол-во', 'Цена', 'Сумма'];
    const csvLines = [headers.join(';')];

    for (const r of rows) {
      csvLines.push([
        r.invoice_id,
        `"${r.date || ''}"`,
        `"${(r.supplier || '').replace(/"/g, '""')}"`,
        r.warehouse === 'household' ? 'Хоз склад' : 'Кухня',
        r.status,
        r.iiko_document_id || '',
        `"${(r.item_name || '').replace(/"/g, '""')}"`,
        r.qty,
        r.price,
        r.sum
      ].join(';'));
    }

    return csvLines.join('\r\n');
  }

  // --- Bot Edit Sessions (Persistence) ---

  saveEditSession(userId: number, session: {
    invoiceId: number;
    cardMessageId: number;
    chatId: number;
    editPromptMessageId?: number;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO bot_edit_sessions (user_id, invoice_id, card_message_id, chat_id, edit_prompt_message_id, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'))
      ON CONFLICT(user_id) DO UPDATE SET
        invoice_id = excluded.invoice_id,
        card_message_id = excluded.card_message_id,
        chat_id = excluded.chat_id,
        edit_prompt_message_id = excluded.edit_prompt_message_id,
        updated_at = datetime('now', 'localtime')
    `);
    stmt.run(
      userId,
      session.invoiceId,
      session.cardMessageId,
      session.chatId,
      session.editPromptMessageId ?? null
    );
  }

  getEditSession(userId: number): {
    invoiceId: number;
    cardMessageId: number;
    chatId: number;
    editPromptMessageId?: number;
  } | null {
    const stmt = this.db.prepare(`
      SELECT invoice_id, card_message_id, chat_id, edit_prompt_message_id
      FROM bot_edit_sessions
      WHERE user_id = ?
    `);
    const row = stmt.get(userId) as {
      invoice_id: number;
      card_message_id: number;
      chat_id: number;
      edit_prompt_message_id?: number | null;
    } | undefined;

    if (!row) return null;
    return {
      invoiceId: row.invoice_id,
      cardMessageId: row.card_message_id,
      chatId: row.chat_id,
      editPromptMessageId: row.edit_prompt_message_id ?? undefined
    };
  }

  deleteEditSession(userId: number): boolean {
    const stmt = this.db.prepare('DELETE FROM bot_edit_sessions WHERE user_id = ?');
    const res = stmt.run(userId);
    return res.changes > 0;
  }
}
