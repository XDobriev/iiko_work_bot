import { z } from 'zod';

export type WarehouseType = 'kitchen' | 'household';

export const InvoiceItemSchema = z.object({
  name: z.preprocess((val) => String(val || 'Товар').trim(), z.string().min(1)),
  qty: z.preprocess((val) => {
    const n = Number(val);
    return isNaN(n) ? 1 : Math.max(0, n);
  }, z.number().nonnegative().default(1)),
  price: z.preprocess((val) => {
    const n = Number(val);
    return isNaN(n) ? 0 : Math.max(0, n);
  }, z.number().nonnegative().default(0)),
  sum: z.preprocess((val) => {
    const n = Number(val);
    return isNaN(n) ? 0 : Math.max(0, n);
  }, z.number().nonnegative().default(0)),
  unit: z.string().optional()
});

export type InvoiceItem = z.infer<typeof InvoiceItemSchema>;

export const InvoiceDataSchema = z.object({
  date: z.preprocess((val) => (val == null ? '' : String(val).trim()), z.string().default('')),
  supplier: z.preprocess((val) => (val == null || !String(val).trim() ? 'Не указан' : String(val).trim()), z.string().default('Не указан')),
  warehouse: z.preprocess((val) => {
    const s = String(val || '').toLowerCase();
    if (s.includes('house') || s.includes('хоз')) return 'household';
    return 'kitchen';
  }, z.enum(['kitchen', 'household']).default('kitchen')),
  items: z.preprocess((val) => (Array.isArray(val) ? val : []), z.array(InvoiceItemSchema).default([])),
  total_written: z.preprocess((val) => {
    if (val == null) return null;
    const n = Number(val);
    return isNaN(n) ? null : n;
  }, z.number().nullable().default(null)),
  notes: z.string().optional()
});

export type InvoiceData = z.infer<typeof InvoiceDataSchema>;

export type InvoiceStatus = 'pending' | 'confirmed' | 'rejected' | 'synced';

export interface InvoiceRecord {
  id: number;
  date: string;
  supplier: string;
  warehouse: WarehouseType;
  total_calculated: number;
  total_written: number | null;
  status: InvoiceStatus;
  iiko_document_id?: string | null;
  telegram_user_id?: number | null;
  telegram_message_id?: number | null;
  photo_file_id?: string | null;
  created_at: string;
}

export interface InvoiceItemRecord {
  id: number;
  invoice_id: number;
  name: string;
  qty: number;
  price: number;
  sum: number;
  unit?: string;
  created_at: string;
}

export interface InvoiceDomainRecord {
  invoice: InvoiceRecord & { local_photo_path?: string; raw_json?: string };
  items: InvoiceItemRecord[];
  data: InvoiceData;
}

export interface ProductMappingRecord {
  id: number;
  raw_name: string;
  normalized_name: string;
  iiko_product_name: string;
  iiko_product_id?: string | null;
  updated_at: string;
}

export interface PriceComparisonItem {
  name: string;
  currentPrice: number;
  currentQty: number;
  currentSum: number;
  currentUnit?: string;
  previousPrice: number | null;
  previousDate: string | null;
  previousUnit?: string | null;
  deltaRub: number | null;
  deltaPercent: number | null;
  trend: 'up' | 'down' | 'same' | 'new';
  isAnomaly?: boolean;
  anomalyMessage?: string;
}

export interface KnownItemWithUnit {
  name: string;
  unit?: string;
}

export interface HistoricalComparison {
  isDuplicate: boolean;
  duplicateInvoiceId?: number;
  duplicateDate?: string;
  priceComparisons: PriceComparisonItem[];
  totalPriceDelta: number;
  mathDiscrepancy: boolean;
  discrepancyDiff: number;
}
