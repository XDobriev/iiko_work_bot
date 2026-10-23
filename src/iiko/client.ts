import { config } from '../config.js';
import { InvoiceData } from '../types/index.js';

export interface IikoCreateInvoiceResult {
  success: boolean;
  documentId?: string;
  documentNumber?: string;
  isMock?: boolean;
  message?: string;
  unmatched?: string[];
  raw?: any;
}

interface IikoSupplier {
  id: string;
  name: string;
  deleted?: boolean;
}

interface IikoStorage {
  id: string;
  name: string;
  deleted?: boolean;
}

interface IikoProductShort {
  id: string;
  name: string;
  type: string;
  isDeleted?: boolean;
}

const SESSION_TTL_MS = 15 * 60 * 1000;

// iikoWeb answers 500 on Node's default "Accept-Language: *", so a concrete locale is required.
const BASE_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'Accept-Language': 'ru-RU'
};

/**
 * Normalizes names for matching: drops type tags like "|ПФ|", "*", punctuation and case.
 */
function normalizeIikoName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\|[^|]*\|/g, ' ')
    .replace(/[*«»"'()[\],.:;!?-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Client for the iikoWeb public API (https://<domain>.iikoweb.ru/api/...).
 * Auth is a cookie session obtained via POST /api/auth/login.
 * Invoices are always created as DRAFT — the user posts them manually in iikoWeb.
 */
export class IikoClient {
  private url: string;
  private login: string;
  private password?: string;
  private cookie: string | null = null;
  private cookieExpiresAt = 0;

  constructor() {
    this.url = config.iiko.url;
    this.login = config.iiko.login;
    this.password = config.iiko.password;
  }

  isConfigured(): boolean {
    return Boolean(this.url && this.login && this.password);
  }

  private async authenticate(): Promise<void> {
    if (!this.password) {
      throw new Error('IIKO_PASSWORD не задан в конфигурации.');
    }

    const res = await fetch(`${this.url}/api/auth/login`, {
      method: 'POST',
      headers: { ...BASE_HEADERS },
      body: JSON.stringify({ login: this.login, password: this.password })
    });

    const bodyText = await res.text();
    if (!res.ok) {
      throw new Error(`Ошибка авторизации iiko (${res.status}): ${bodyText.slice(0, 300)}`);
    }

    const cookies = res.headers
      .getSetCookie()
      .map(c => c.split(';')[0])
      .filter(c => c.startsWith('PHPSESSID=') || c.startsWith('by='));
    if (!cookies.length) {
      throw new Error('iiko не вернул сессионную cookie после входа.');
    }

    this.cookie = cookies.join('; ');
    this.cookieExpiresAt = Date.now() + SESSION_TTL_MS;
  }

  private async request<T = any>(path: string, init?: { method?: string; body?: unknown }, retried = false): Promise<T> {
    if (!this.cookie || this.cookieExpiresAt <= Date.now()) {
      await this.authenticate();
    }

    const res = await fetch(`${this.url}${path}`, {
      method: init?.method || 'GET',
      headers: { ...BASE_HEADERS, Cookie: this.cookie as string },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body)
    });

    if ((res.status === 401 || res.status === 403) && !retried) {
      this.cookie = null;
      return this.request<T>(path, init, true);
    }

    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`iiko ${path}: неожиданный ответ (${res.status}): ${text.slice(0, 200)}`);
    }

    if (!res.ok || (data && !Array.isArray(data) && data.error === true)) {
      const reason = data?.errorMessage || data?.message || JSON.stringify(data).slice(0, 300);
      throw new Error(`iiko ${path} (${res.status}): ${reason}`);
    }

    return data as T;
  }

  /** Releases the session on the iiko side. */
  async logout(): Promise<void> {
    if (!this.cookie) return;
    try {
      await this.request('/api/auth/logout');
    } catch {
      // session may already be expired — nothing to release
    } finally {
      this.cookie = null;
    }
  }

  async getSuppliers(): Promise<IikoSupplier[]> {
    const res = await this.request<{ data: Record<string, IikoSupplier> }>('/api/documents/suppliers/list');
    return Object.values(res.data || {}).filter(s => !s.deleted);
  }

  async getStorages(): Promise<IikoStorage[]> {
    const res = await this.request<{ data: IikoStorage[] }>('/api/documents/storage/list');
    return (res.data || []).filter(s => !s.deleted);
  }

  async getProducts(): Promise<IikoProductShort[]> {
    const res = await this.request<IikoProductShort[]>('/api/documents/product/short_list');
    return res.filter(p => !p.isDeleted && p.type !== 'MODIFIER');
  }

  private async getDefaultConceptionId(): Promise<string | undefined> {
    const res = await this.request<{ data: Record<string, { id: string; code?: string }> }>('/api/documents/conception/list');
    const all = Object.values(res.data || {});
    return (all.find(c => c.code === 'no_concept') || all[0])?.id;
  }

  private findByName<T extends { name: string }>(list: T[], rawName: string): T | undefined {
    const wanted = normalizeIikoName(rawName);
    if (!wanted) return undefined;

    const exact = list.find(x => normalizeIikoName(x.name) === wanted);
    if (exact) return exact;

    // Fallback: closest containing match (shortest name wins)
    return list
      .filter(x => {
        const n = normalizeIikoName(x.name);
        return n.includes(wanted) || wanted.includes(n);
      })
      .sort((a, b) => a.name.length - b.name.length)[0];
  }

  private parseDate(date?: string): string {
    const m = (date || '').match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    const iso = m
      ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
      : new Date().toISOString().slice(0, 10);
    return `${iso}T09:00:00+03:00`;
  }

  async createInvoice(invoice: InvoiceData): Promise<IikoCreateInvoiceResult> {
    // If not configured, run in safe Mock/Dry-run mode
    if (!this.isConfigured()) {
      const mockDocNum = `MOCK-${Date.now().toString().slice(-6)}`;
      return {
        success: true,
        isMock: true,
        documentNumber: mockDocNum,
        documentId: `mock-guid-${Date.now()}`,
        message: 'Демо-режим (пароль iiko не был указан в .env, накладная успешно зафиксирована локально)'
      };
    }

    try {
      const [suppliers, storages, products, conceptionId] = await Promise.all([
        this.getSuppliers(),
        this.getStorages(),
        this.getProducts(),
        this.getDefaultConceptionId()
      ]);

      const supplier = this.findByName(suppliers, invoice.supplier || '');
      if (!supplier) {
        return {
          success: false,
          message: `Поставщик «${invoice.supplier}» не найден в iiko. Добавьте его в iikoWeb или поправьте название накладной.`
        };
      }

      const keywords = invoice.warehouse === 'household' ? ['хоз', 'household'] : ['кухн', 'kitchen'];
      const storage =
        storages.find(s => keywords.some(k => s.name.toLowerCase().includes(k))) || storages[0];
      if (!storage) {
        return { success: false, message: 'В iiko не найдено ни одного склада.' };
      }

      const matched: Array<{ productId: string; qty: number; price: number; sum: number }> = [];
      const unmatched: string[] = [];
      for (const item of invoice.items) {
        const product = this.findByName(products, item.name);
        if (!product) {
          unmatched.push(item.name);
          continue;
        }
        const sum = item.sum || item.qty * item.price;
        matched.push({ productId: product.id, qty: item.qty, price: item.price, sum });
      }

      if (!matched.length) {
        return {
          success: false,
          unmatched,
          message: `Ни один товар не найден в номенклатуре iiko: ${unmatched.join(', ')}`
        };
      }

      const templates = await this.request<any[]>('/api/documents/product/ids', {
        method: 'POST',
        body: matched.map(m => m.productId)
      });
      const templateById = new Map(templates.map(t => [t.id, t]));

      const dateIncoming = this.parseDate(invoice.date);
      const header = {
        type: 'INCOMING_INVOICE',
        documentNumber: '',
        status: 'DRAFT',
        dateIncoming,
        comment: invoice.notes || 'Создано iiko-bot из фото накладной',
        conception: conceptionId,
        store: String((await this.request<any>('/api/stores/list')).stores?.[0]?.id ?? ''),
        editable: true,
        isAutomatic: false,
        invoice: '',
        invoiceDate: '',
        incomingDocumentNumber: null,
        transportInvoiceNumber: null,
        externalOrderNumber: null,
        mapping_value: '',
        fromExternalService: null,
        supplier: supplier.id,
        storage: storage.id
      };

      const created = await this.request<{ data: { id: string; documentNumber: string } }>('/api/documents/create', {
        method: 'POST',
        body: header
      });
      const { id: documentId, documentNumber } = created.data;

      const items = matched.map(m => {
        const t = templateById.get(m.productId);
        return {
          ...t,
          actualAmount: m.qty,
          amount: m.qty,
          count: m.qty,
          price: m.price,
          priceWithoutNds: m.price,
          sum: m.sum,
          sumWithoutNds: m.sum,
          ndsPercent: 0,
          id: null,
          storage: storage.id
        };
      });

      await this.request(`/api/documents/save/${documentId}`, {
        method: 'POST',
        body: { ...header, documentNumber, items, invoice: null, fromExternalService: false }
      });

      return {
        success: true,
        documentId,
        documentNumber,
        unmatched: unmatched.length ? unmatched : undefined,
        message: unmatched.length
          ? `Не найдены в номенклатуре iiko и не добавлены: ${unmatched.join(', ')}`
          : undefined
      };
    } catch (err: any) {
      return {
        success: false,
        message: err.message || 'Ошибка отправки в iiko'
      };
    } finally {
      await this.logout();
    }
  }
}
