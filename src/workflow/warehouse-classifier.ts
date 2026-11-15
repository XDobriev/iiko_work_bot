import { InvoiceItem, WarehouseType } from '../types/index.js';

/**
 * Keyword roots that guaranteed classify an item as household (Хоз склад).
 * Per project requirements: перчатк*, салфетк*, моющее, губк*, пакет*, тряпк*, уголь, дез*
 * Plus common restaurant packaging/cleaning supplies.
 */
const HOUSEHOLD_KEYWORD_ROOTS: string[] = [
  'перчатк',
  'салфетк',
  'моюще',
  'моющ',
  'губк',
  'пакет',
  'тряпк',
  'уголь',
  'дез',
  'фольг',
  'контейнер',
  'мыл',
  'белизн',
  'пленк',
  'плёнк',
  'химия',
  'бахил',
  'чистящ',
  'туалетн',
  'зубочистк',
  'трубочк',
  'стакан',
  'мусорн'
];

/**
 * Normalizes item name for keyword analysis.
 */
export function normalizeClassifierText(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Checks whether item name contains household root keywords.
 */
export function isHouseholdItemName(name: string): boolean {
  const normalized = normalizeClassifierText(name);
  if (!normalized) return false;

  const words = normalized.split(' ');
  return words.some(word =>
    HOUSEHOLD_KEYWORD_ROOTS.some(root => word.startsWith(root) || word.includes(root))
  );
}

/**
 * Classifies an item into either 'kitchen' or 'household'.
 *
 * Rules:
 * 1. If explicitWarehouse ('kitchen' or 'household') is provided, honor it.
 * 2. If name matches household roots -> 'household'.
 * 3. Default to fallback warehouse (defaults to 'kitchen').
 */
export function classifyItemWarehouse(
  name: string,
  explicitWarehouse?: WarehouseType,
  fallbackWarehouse: WarehouseType = 'kitchen'
): WarehouseType {
  if (explicitWarehouse === 'household' || explicitWarehouse === 'kitchen') {
    return explicitWarehouse;
  }

  if (isHouseholdItemName(name)) {
    return 'household';
  }

  return fallbackWarehouse;
}

/**
 * Enriches and validates an array of items with warehouse classification.
 * Used primarily after initial AI recognition to enforce guaranteed household keyword roots.
 */
export function classifyInvoiceItems(
  items: InvoiceItem[],
  defaultWarehouse: WarehouseType = 'kitchen'
): InvoiceItem[] {
  return items.map(item => {
    const warehouse = isHouseholdItemName(item.name)
      ? 'household'
      : (item.warehouse || defaultWarehouse);
    return {
      ...item,
      warehouse
    };
  });
}

/**
 * Partitions items into two separate lists: kitchen vs household.
 */
export function partitionItemsByWarehouse(items: InvoiceItem[]): {
  kitchen: InvoiceItem[];
  household: InvoiceItem[];
  isMixed: boolean;
} {
  const kitchen: InvoiceItem[] = [];
  const household: InvoiceItem[] = [];

  for (const item of items) {
    const wh = item.warehouse || classifyItemWarehouse(item.name);
    if (wh === 'household') {
      household.push({ ...item, warehouse: 'household' });
    } else {
      kitchen.push({ ...item, warehouse: 'kitchen' });
    }
  }

  return {
    kitchen,
    household,
    isMixed: kitchen.length > 0 && household.length > 0
  };
}
