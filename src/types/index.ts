import { z } from 'zod';

export type WarehouseType = 'kitchen' | 'household';

export const InvoiceItemSchema = z.object({
  name: z.string().min(1),
  qty: z.number().nonnegative(),
  price: z.number().nonnegative(),
  sum: z.number().nonnegative(),
  unit: z.string().optional()
});

export type InvoiceItem = z.infer<typeof InvoiceItemSchema>;

export const InvoiceDataSchema = z.object({
  date: z.string().default(''),
  supplier: z.string().default('Не указан'),
  warehouse: z.enum(['kitchen', 'household']).default('kitchen'),
  items: z.array(InvoiceItemSchema).default([]),
  total_written: z.number().nullable().optional().default(null),
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
  created_at: string;
}

export interface PriceComparisonItem {
  name: string;
  currentPrice: number;
  currentQty: number;
  currentSum: number;
  previousPrice: number | null;
  previousDate: string | null;
  deltaRub: number | null;
  deltaPercent: number | null;
  trend: 'up' | 'down' | 'same' | 'new';
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
