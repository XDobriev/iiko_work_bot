import crypto from 'node:crypto';
import { config } from '../config.js';
import { InvoiceData } from '../types/index.js';

export interface IikoCreateInvoiceResult {
  success: boolean;
  documentId?: string;
  documentNumber?: string;
  isMock?: boolean;
  message?: string;
  raw?: any;
}

export class IikoClient {
  private url: string;
  private login: string;
  private password?: string;
  private tokenCache: { token: string; expiresAt: number } | null = null;

  constructor() {
    this.url = config.iiko.url;
    this.login = config.iiko.login;
    this.password = config.iiko.password;
  }

  isConfigured(): boolean {
    return Boolean(this.url && this.login && this.password);
  }

  private sha1(str: string): string {
    return crypto.createHash('sha1').update(str).digest('hex');
  }

  async getAccessToken(): Promise<string> {
    if (!this.password) {
      throw new Error('IIKO_PASSWORD не задан в конфигурации.');
    }

    if (this.tokenCache && this.tokenCache.expiresAt > Date.now()) {
      return this.tokenCache.token;
    }

    const pwdHash = this.sha1(this.password);
    const url = `${this.url}/api/1/access_token?user_id=${encodeURIComponent(this.login)}&user_secret=${pwdHash}`;

    const res = await fetch(url);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ошибка авторизации iiko (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as { token: string };
    if (!data.token) {
      throw new Error(`iiko не вернул токен доступа. Ответ: ${JSON.stringify(data)}`);
    }

    // Cache token for 30 minutes
    this.tokenCache = {
      token: data.token,
      expiresAt: Date.now() + 30 * 60 * 1000
    };

    return data.token;
  }

  async getOrganizations(token: string): Promise<string> {
    const res = await fetch(`${this.url}/api/1/organizations?access_token=${token}`);
    const data = (await res.json()) as any;
    const orgs = data.organizations || data;
    if (!orgs || orgs.length === 0) {
      throw new Error('Не найдено ни одной организации в iiko.');
    }
    return orgs[0].id;
  }

  async getStores(token: string, orgId: string): Promise<any[]> {
    const res = await fetch(`${this.url}/api/1/stores?access_token=${token}&organization=${orgId}`);
    const data = (await res.json()) as any;
    return data.stores || data || [];
  }

  async getProducts(token: string, orgId: string): Promise<any[]> {
    const res = await fetch(`${this.url}/api/1/products?access_token=${token}&organization=${orgId}`);
    const data = (await res.json()) as any;
    return data.products || data || [];
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
      const token = await this.getAccessToken();
      const orgId = await this.getOrganizations(token);
      const stores = await this.getStores(token, orgId);
      const products = await this.getProducts(token, orgId);

      // Warehouse mapping
      const kw: Record<string, string[]> = {
        kitchen: ['кухня', 'kitchen'],
        household: ['хоз', 'household']
      };
      const wkey = invoice.warehouse || 'kitchen';
      const targetKeywords = kw[wkey] || [];

      let storeId = stores[0]?.id || '';
      for (const store of stores) {
        const name = (store.name || '').toLowerCase();
        if (targetKeywords.some(w => name.includes(w))) {
          storeId = store.id;
          break;
        }
      }

      // Match products by name
      const findProduct = (rawName: string) => {
        const clean = rawName.toLowerCase().trim();
        for (const p of products) {
          if ((p.name || '').toLowerCase().trim() === clean) return p;
        }
        for (const p of products) {
          if ((p.name || '').toLowerCase().includes(clean) || clean.includes((p.name || '').toLowerCase())) {
            return p;
          }
        }
        return null;
      };

      const items = invoice.items.map(i => {
        const matched = findProduct(i.name);
        return {
          amount: i.qty || 1,
          price: i.price || 0,
          sum: i.sum || i.qty * i.price,
          product: matched ? { id: matched.id } : { name: i.name }
        };
      });

      // Parse date
      let formattedDate = new Date().toISOString().slice(0, 19);
      if (invoice.date) {
        const parts = invoice.date.split('.');
        if (parts.length === 3) {
          formattedDate = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}T00:00:00`;
        }
      }

      const payload = {
        document: {
          dateIncoming: formattedDate,
          defaultStore: { id: storeId },
          supplier: { name: invoice.supplier || 'Закупка' },
          items
        }
      };

      const res = await fetch(
        `${this.url}/api/1/documents/incoming_invoice?access_token=${token}&organization=${orgId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }
      );

      const result = (await res.json()) as any;
      const docNum = result.documentNumber || result.id || result.number;

      return {
        success: Boolean(docNum),
        documentNumber: docNum,
        documentId: result.id,
        raw: result
      };
    } catch (err: any) {
      return {
        success: false,
        message: err.message || 'Ошибка отправки в iiko'
      };
    }
  }
}
