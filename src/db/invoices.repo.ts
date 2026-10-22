import { DatabaseSync } from 'node:sqlite';
import { getDatabase } from './database.js';
import {
  InvoiceData,
  InvoiceItem,
  InvoiceRecord,
  InvoiceItemRecord,
  InvoiceStatus,
  HistoricalComparison,
  PriceComparisonItem
} from '../types/index.js';

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[«»"'()[\],.:;!?-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
    meta?: { userId?: number; messageId?: number; photoFileId?: string }
  ): { invoiceId: number; totalCalculated: number } {
    let totalCalculated = 0;
    for (const item of data.items) {
      const sum = item.sum || item.qty * item.price;
      totalCalculated += sum;
    }

    const insertInvoice = this.db.prepare(`
      INSERT INTO invoices (
        date, supplier, warehouse, total_calculated, total_written,
        status, telegram_user_id, telegram_message_id, photo_file_id, raw_json
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `);

    const result = insertInvoice.run(
      data.date || new Date().toISOString().slice(0, 10),
      data.supplier || 'Не указан',
      data.warehouse || 'kitchen',
      totalCalculated,
      data.total_written ?? null,
      meta?.userId ?? null,
      meta?.messageId ?? null,
      meta?.photoFileId ?? null,
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

  getInvoiceById(id: number): { invoice: InvoiceRecord; items: InvoiceItemRecord[] } | null {
    const invStmt = this.db.prepare('SELECT * FROM invoices WHERE id = ?');
    const invoice = invStmt.get(id) as unknown as InvoiceRecord | undefined;
    if (!invoice) return null;

    const itemsStmt = this.db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id ASC');
    const items = itemsStmt.all(id) as unknown as InvoiceItemRecord[];

    return { invoice, items };
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

  /**
   * Duplicate detection: checks if an invoice with same supplier and date exists,
   * or has identical items and total.
   */
  checkDuplicate(data: InvoiceData): { isDuplicate: boolean; duplicateInvoiceId?: number; duplicateDate?: string } {
    if (!data.supplier || data.supplier === 'Не указан') {
      return { isDuplicate: false };
    }

    const stmt = this.db.prepare(`
      SELECT id, date, total_calculated, total_written
      FROM invoices
      WHERE supplier = ? AND date = ? AND status != 'rejected'
      ORDER BY id DESC LIMIT 1
    `);

    const existing = stmt.get(data.supplier, data.date) as
      | { id: number; date: string; total_calculated: number; total_written: number | null }
      | undefined;

    if (existing) {
      return {
        isDuplicate: true,
        duplicateInvoiceId: existing.id,
        duplicateDate: existing.date
      };
    }

    return { isDuplicate: false };
  }

  /**
   * Compares each item with previous prices in history.
   */
  compareWithHistory(data: InvoiceData): HistoricalComparison {
    const dup = this.checkDuplicate(data);
    const priceComparisons: PriceComparisonItem[] = [];
    let totalPriceDelta = 0;
    let totalCalculated = 0;

    const findPriceStmt = this.db.prepare(`
      SELECT ii.price, i.date, i.supplier
      FROM invoice_items ii
      JOIN invoices i ON ii.invoice_id = i.id
      WHERE ii.normalized_name = ? AND i.status != 'rejected'
      ORDER BY i.id DESC LIMIT 1
    `);

    for (const item of data.items) {
      const sum = item.sum || item.qty * item.price;
      totalCalculated += sum;
      const normName = normalizeName(item.name);

      const prev = findPriceStmt.get(normName) as
        | { price: number; date: string; supplier: string }
        | undefined;

      if (prev && prev.price > 0) {
        const deltaRub = Math.round((item.price - prev.price) * 100) / 100;
        const deltaPercent = Math.round(((item.price - prev.price) / prev.price) * 1000) / 10;
        const totalDeltaForItem = deltaRub * item.qty;
        totalPriceDelta += totalDeltaForItem;

        let trend: 'up' | 'down' | 'same' = 'same';
        if (deltaRub > 0.01) trend = 'up';
        else if (deltaRub < -0.01) trend = 'down';

        priceComparisons.push({
          name: item.name,
          currentPrice: item.price,
          currentQty: item.qty,
          currentSum: sum,
          previousPrice: prev.price,
          previousDate: prev.date,
          deltaRub,
          deltaPercent,
          trend
        });
      } else {
        priceComparisons.push({
          name: item.name,
          currentPrice: item.price,
          currentQty: item.qty,
          currentSum: sum,
          previousPrice: null,
          previousDate: null,
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

  getKnownItems(limit: number = 100): string[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT name
      FROM invoice_items
      ORDER BY id DESC LIMIT ?
    `);
    const rows = stmt.all(limit) as { name: string }[];
    return rows.map(r => r.name);
  }

  getKnownSuppliers(limit: number = 50): string[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT supplier
      FROM invoices
      WHERE supplier != 'Не указан'
      ORDER BY id DESC LIMIT ?
    `);
    const rows = stmt.all(limit) as { supplier: string }[];
    return rows.map(r => r.supplier);
  }

  getRecentInvoices(limit: number = 10): InvoiceRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM invoices
      ORDER BY id DESC LIMIT ?
    `);
    return stmt.all(limit) as unknown as InvoiceRecord[];
  }
}
