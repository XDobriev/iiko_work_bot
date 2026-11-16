import {
  InvoiceData,
  InvoiceItem,
  WarehouseType,
  InvoiceDomainRecord
} from '../types/index.js';
import { IikoClient } from './client.js';
import {
  CatalogProduct,
  ProductCatalogMatcher,
  MatchStatus,
  ProductSuggestion
} from './matcher.js';
import { partitionItemsByWarehouse } from '../workflow/warehouse-classifier.js';
import { InvoicesRepository } from '../db/invoices.repo.js';

export interface NomenclatureItemAnalysis {
  index: number;
  name: string;
  status: MatchStatus;
  matchedName?: string;
  matchedId?: string;
  suggestions: ProductSuggestion[];
}

export interface NomenclatureAnalysisResult {
  items: NomenclatureItemAnalysis[];
  hasUnmatched: boolean;
  unmatchedNames: string[];
}

export interface GatewaySyncResult {
  success: boolean;
  alreadySynced?: boolean;
  inProgress?: boolean;
  documentNumber?: string;
  documentNumbers?: { kitchen?: string; household?: string };
  isMock?: boolean;
  isSplit?: boolean;
  unmatched?: string[];
  unitWarnings?: string[];
  message?: string;
}

export interface IIkoAccountingGateway {
  syncInvoice(domain: InvoiceDomainRecord): Promise<GatewaySyncResult>;
  getProducts(): Promise<CatalogProduct[]>;
  clearCache(): void;
  analyzeNomenclature(items: InvoiceItem[]): Promise<NomenclatureAnalysisResult>;
}

export interface LiveAccountingGatewayOptions {
  client?: IikoClient;
  repo?: InvoicesRepository;
}

/**
 * Live adapter for iikoWeb accounting API.
 * Unifies warehouse partition, catalog nomenclature matching, cookie session serialization,
 * and dual-draft creation behind an isolated accounting gateway seam.
 */
export class LiveIikoAccountingGateway implements IIkoAccountingGateway {
  private client: IikoClient;
  private repo?: InvoicesRepository;
  private sessionMutex: Promise<void> = Promise.resolve();

  constructor(options: LiveAccountingGatewayOptions = {}) {
    this.repo = options.repo;
    this.client = options.client || new IikoClient(this.repo);
  }

  getClient(): IikoClient {
    return this.client;
  }

  async getProducts(): Promise<CatalogProduct[]> {
    if (typeof this.client.getProducts === 'function') {
      return this.client.getProducts();
    }
    return [];
  }

  clearCache(): void {
    if (typeof (this.client as any).clearProductsCache === 'function') {
      (this.client as any).clearProductsCache();
    } else if (typeof (this.client as any).clearCache === 'function') {
      (this.client as any).clearCache();
    }
  }

  async analyzeNomenclature(items: InvoiceItem[]): Promise<NomenclatureAnalysisResult> {
    const products = await this.getProducts();
    const matcher = new ProductCatalogMatcher(products, this.repo);

    let hasUnmatched = false;
    const unmatchedNames: string[] = [];

    const analyzedItems: NomenclatureItemAnalysis[] = items.map((it, idx) => {
      const analysis = matcher.analyzeItem(it.name, it.unit, it.iiko_product_name);
      if (analysis.status !== 'matched' || !analysis.match) {
        hasUnmatched = true;
        unmatchedNames.push(it.name);
      }
      return {
        index: idx,
        name: it.name,
        status: analysis.status,
        matchedName: analysis.match?.product.name || it.iiko_product_name,
        matchedId: analysis.match?.product.id || it.iiko_product_id,
        suggestions: analysis.suggestions
      };
    });

    return {
      items: analyzedItems,
      hasUnmatched,
      unmatchedNames
    };
  }

  async syncInvoice(domain: InvoiceDomainRecord): Promise<GatewaySyncResult> {
    return this.withSessionLock(async () => {
      // 1. Block creation if any item is not matched to iiko nomenclature
      if (typeof this.client.getProducts === 'function') {
        try {
          const products = await this.client.getProducts();
          if (products.length > 0) {
            const matcher = new ProductCatalogMatcher(products, this.repo);
            const unmatched: string[] = [];
            for (const item of domain.data.items) {
              const analysis = matcher.analyzeItem(item.name, item.unit, item.iiko_product_name);
              if (analysis.status !== 'matched' || !analysis.match) {
                unmatched.push(item.name);
              }
            }

            if (unmatched.length > 0) {
              return {
                success: false,
                unmatched,
                message: `Создание накладной заблокировано: в накладной обнаружены несопоставленные позиции (${unmatched.join(', ')}). Сопоставьте их с номенклатурой iiko в Mini App перед отправкой.`
              };
            }
          }
        } catch {
          // Fallback to client.createInvoice check
        }
      }

      // 2. Warehouse partitioning
      const { kitchen, household, isMixed } = partitionItemsByWarehouse(
        domain.data.items,
        domain.data.warehouse
      );

      // 3. Mixed warehouse: create TWO separate draft documents in iikoWeb sequentially
      if (isMixed) {
        const kitchenData: InvoiceData = {
          ...domain.data,
          warehouse: 'kitchen',
          items: kitchen,
          total_written: null,
          notes: (domain.data.notes ? domain.data.notes + ' ' : '') + '[Склад Кухня]'
        };

        const householdData: InvoiceData = {
          ...domain.data,
          warehouse: 'household',
          items: household,
          total_written: null,
          notes: (domain.data.notes ? domain.data.notes + ' ' : '') + '[Хоз склад]'
        };

        const resKitchen = await this.client.createInvoice(kitchenData);
        if (!resKitchen.success) {
          return {
            success: false,
            unmatched: resKitchen.unmatched,
            unitWarnings: resKitchen.unitWarnings,
            message: `Ошибка отправки накладной «Кухня» в iiko: ${resKitchen.message}`
          };
        }

        const resHousehold = await this.client.createInvoice(householdData);
        if (!resHousehold.success) {
          return {
            success: false,
            documentNumber: resKitchen.documentNumber,
            isSplit: true,
            unmatched: resHousehold.unmatched,
            unitWarnings: resHousehold.unitWarnings,
            message: `Накладная «Кухня» успешно создана в iiko (#${resKitchen.documentNumber || '—'}), но отправка «Хоз склад» завершилась ошибкой: ${resHousehold.message}. Статус зафиксирован, чтобы избежать дублирования кухни.`
          };
        }

        const combinedDocNum = `🍽 Кухня: ${resKitchen.documentNumber || '—'}, 🏠 Хоз: ${resHousehold.documentNumber || '—'}`;
        const allUnmatched = [...(resKitchen.unmatched || []), ...(resHousehold.unmatched || [])];
        const allUnitWarnings = [...(resKitchen.unitWarnings || []), ...(resHousehold.unitWarnings || [])];

        return {
          success: true,
          documentNumber: combinedDocNum,
          documentNumbers: {
            kitchen: resKitchen.documentNumber,
            household: resHousehold.documentNumber
          },
          isMock: Boolean(resKitchen.isMock || resHousehold.isMock),
          isSplit: true,
          unmatched: allUnmatched.length ? allUnmatched : undefined,
          unitWarnings: allUnitWarnings.length ? allUnitWarnings : undefined,
          message: `Создано 2 накладных: Склад Кухня (${resKitchen.documentNumber}) и Хоз склад (${resHousehold.documentNumber})`
        };
      }

      // 4. Single warehouse
      const targetWh: WarehouseType =
        household.length > 0 && kitchen.length === 0
          ? 'household'
          : kitchen.length > 0 && household.length === 0
          ? 'kitchen'
          : (domain.data.warehouse || 'kitchen');

      const singleData: InvoiceData = {
        ...domain.data,
        warehouse: targetWh,
        items: domain.data.items.map(it => ({ ...it, warehouse: targetWh }))
      };

      const result = await this.client.createInvoice(singleData);
      if (result.success) {
        return {
          success: true,
          documentNumber: result.documentNumber,
          isMock: result.isMock,
          isSplit: false,
          unmatched: result.unmatched,
          unitWarnings: result.unitWarnings,
          message: result.message
        };
      }

      return {
        success: false,
        unmatched: result.unmatched,
        unitWarnings: result.unitWarnings,
        message: result.message || 'Ошибка отправки в iiko'
      };
    });
  }

  private async withSessionLock<T>(action: () => Promise<T>): Promise<T> {
    const prev = this.sessionMutex;
    let release: () => void = () => {};
    this.sessionMutex = new Promise<void>(resolve => {
      release = resolve;
    });

    try {
      await prev;
      return await action();
    } finally {
      release();
    }
  }
}

/**
 * Mock adapter for headless testing without real iiko credentials.
 */
export class MockIikoAccountingGateway implements IIkoAccountingGateway {
  private products: CatalogProduct[];
  public syncCalls: InvoiceDomainRecord[] = [];
  public shouldFail: boolean = false;
  public failMessage?: string;
  public partialSplitFail: boolean = false;

  constructor(products: CatalogProduct[] = []) {
    this.products = products;
  }

  async getProducts(): Promise<CatalogProduct[]> {
    return this.products;
  }

  clearCache(): void {}

  async analyzeNomenclature(items: InvoiceItem[]): Promise<NomenclatureAnalysisResult> {
    const matcher = new ProductCatalogMatcher(this.products);
    let hasUnmatched = false;
    const unmatchedNames: string[] = [];

    const analyzed = items.map((it, idx) => {
      const a = matcher.analyzeItem(it.name, it.unit, it.iiko_product_name);
      if (a.status !== 'matched' || !a.match) {
        hasUnmatched = true;
        unmatchedNames.push(it.name);
      }
      return {
        index: idx,
        name: it.name,
        status: a.status,
        matchedName: a.match?.product.name || it.iiko_product_name,
        matchedId: a.match?.product.id || it.iiko_product_id,
        suggestions: a.suggestions
      };
    });

    return { items: analyzed, hasUnmatched, unmatchedNames };
  }

  async syncInvoice(domain: InvoiceDomainRecord): Promise<GatewaySyncResult> {
    this.syncCalls.push(domain);
    if (this.shouldFail) {
      return {
        success: false,
        message: this.failMessage || 'Mock sync failure'
      };
    }

    // Check nomenclature when mock products list is non-empty
    if (this.products.length > 0) {
      const analysis = await this.analyzeNomenclature(domain.data.items);
      if (analysis.hasUnmatched) {
        return {
          success: false,
          unmatched: analysis.unmatchedNames,
          message: `Создание накладной заблокировано: в накладной обнаружены несопоставленные позиции (${analysis.unmatchedNames.join(', ')}). Сопоставьте их с номенклатурой iiko в Mini App перед отправкой.`
        };
      }
    }

    // Warehouse partitioning
    const { kitchen, household, isMixed } = partitionItemsByWarehouse(
      domain.data.items,
      domain.data.warehouse
    );

    if (isMixed) {
      if (this.partialSplitFail) {
        const docKitchen = `MOCK-KITCHEN-${domain.invoice.id}`;
        return {
          success: false,
          documentNumber: docKitchen,
          isSplit: true,
          message: `Накладная «Кухня» успешно создана в iiko (#${docKitchen}), но отправка «Хоз склад» завершилась ошибкой: Симулированный сбой хоз склада. Статус зафиксирован, чтобы избежать дублирования кухни.`
        };
      }

      const docKitchen = `MOCK-KITCHEN-${domain.invoice.id}`;
      const docHousehold = `MOCK-HOUSEHOLD-${domain.invoice.id}`;
      return {
        success: true,
        documentNumber: `🍽 Кухня: ${docKitchen}, 🏠 Хоз: ${docHousehold}`,
        documentNumbers: { kitchen: docKitchen, household: docHousehold },
        isMock: true,
        isSplit: true,
        message: `Создано 2 накладных: Склад Кухня (${docKitchen}) и Хоз склад (${docHousehold})`
      };
    }

    return {
      success: true,
      documentNumber: `MOCK-${domain.invoice.id}`,
      isMock: true,
      isSplit: false,
      message: 'Mock document successfully created'
    };
  }
}
