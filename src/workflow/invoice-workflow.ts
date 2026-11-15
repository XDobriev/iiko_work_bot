import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { InvoicesRepository } from '../db/invoices.repo.js';
import { GeminiInvoiceRecognizer } from '../gemini/recognizer.js';
import { IikoClient, IikoCreateInvoiceResult } from '../iiko/client.js';
import {
  CatalogProduct,
  ProductCatalogMatcher,
  MatchStatus,
  ProductSuggestion,
  normalizeIikoName
} from '../iiko/matcher.js';
import {
  InvoiceData,
  InvoiceItem,
  HistoricalComparison,
  WarehouseType,
  InvoiceDomainRecord,
  ProductMappingRecord
} from '../types/index.js';
import { formatInvoiceMessage } from '../bot/formatter.js';
import { formatEditableInvoice, parseInvoiceEditText } from '../bot/parser.js';
import { partitionItemsByWarehouse } from './warehouse-classifier.js';

export interface InvoiceWorkflowDeps {
  repo?: InvoicesRepository;
  recognizer?: GeminiInvoiceRecognizer;
  iikoClient?: IikoClient;
  photosDir?: string;
}

export interface ProcessInvoiceResult {
  invoiceId: number;
  data: InvoiceData;
  comparison: HistoricalComparison;
  cardText: string;
  localPhotoPath?: string;
  hasPhoto: boolean;
}

export interface ToggleWarehouseResult {
  success: boolean;
  newWarehouse?: WarehouseType;
  data?: InvoiceData;
  comparison?: HistoricalComparison;
  cardText?: string;
  hasPhoto?: boolean;
  error?: string;
}

export interface EditInvoiceResult {
  success: boolean;
  message: string;
  data?: InvoiceData;
  comparison?: HistoricalComparison;
  cardText?: string;
  editableText?: string;
  hasPhoto?: boolean;
}

export interface DeleteItemResult {
  success: boolean;
  removedItem?: InvoiceItem;
  data?: InvoiceData;
  comparison?: HistoricalComparison;
  cardText?: string;
  editableText?: string;
  hasPhoto?: boolean;
  error?: string;
}

export interface SyncInvoiceResult {
  success: boolean;
  alreadySynced?: boolean;
  documentNumber?: string;
  documentNumbers?: { kitchen?: string; household?: string };
  isMock?: boolean;
  isSplit?: boolean;
  unmatched?: string[];
  unitWarnings?: string[];
  message?: string;
}

export class InvoiceWorkflow {
  private repo: InvoicesRepository;
  private recognizer: GeminiInvoiceRecognizer;
  private iikoClient: IikoClient;
  private photosDir: string;

  constructor(deps: InvoiceWorkflowDeps = {}) {
    this.repo = deps.repo || new InvoicesRepository();
    this.recognizer = deps.recognizer || new GeminiInvoiceRecognizer();
    this.iikoClient = deps.iikoClient || new IikoClient(this.repo);
    this.photosDir = deps.photosDir || path.resolve(path.dirname(config.db.path), 'photos');

    if (!fs.existsSync(this.photosDir)) {
      try {
        fs.mkdirSync(this.photosDir, { recursive: true });
      } catch {
        // ignore if already exists or read-only
      }
    }
  }

  getRepo(): InvoicesRepository {
    return this.repo;
  }

  async getCatalogProducts(): Promise<CatalogProduct[]> {
    if (typeof this.iikoClient.getProducts === 'function') {
      return this.iikoClient.getProducts();
    }
    return [];
  }

  async enrichItemsWithCatalogMatch(data: InvoiceData): Promise<void> {
    try {
      const products = await this.getCatalogProducts();
      if (products.length > 0) {
        const matcher = new ProductCatalogMatcher(products, this.repo);
        for (const item of data.items) {
          if (!item.iiko_product_name) {
            const analysis = matcher.analyzeItem(item.name, item.unit);
            if (analysis.status === 'matched' && analysis.match) {
              item.iiko_product_name = analysis.match.product.name;
              item.iiko_product_id = analysis.match.product.id;
            }
          }
        }
      }
    } catch {
      // Non-blocking
    }
  }

  async getInvoiceMatcherAnalysis(invoiceId: number): Promise<{
    items: Array<{
      index: number;
      name: string;
      status: MatchStatus;
      matchedName?: string;
      matchedId?: string;
      suggestions: ProductSuggestion[];
    }>;
    hasUnmatched: boolean;
  }> {
    const domain = this.repo.getInvoice(invoiceId);
    if (!domain) {
      return { items: [], hasUnmatched: false };
    }

    const products = await this.getCatalogProducts();
    const matcher = new ProductCatalogMatcher(products, this.repo);

    let hasUnmatched = false;
    const items = domain.data.items.map((it, idx) => {
      const analysis = matcher.analyzeItem(it.name, it.unit, it.iiko_product_name);
      if (analysis.status !== 'matched') {
        hasUnmatched = true;
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

    return { items, hasUnmatched };
  }

  async processPhotoInvoice(input: {
    photoBuffer: Buffer;
    userId?: number;
    messageId?: number;
    photoFileId?: string;
  }): Promise<ProcessInvoiceResult> {
    const knownItemsWithUnits = this.repo.getKnownItemsWithUnits(60);
    const knownSuppliers = this.repo.getKnownSuppliers(30);

    const data = await this.recognizer.recognize(input.photoBuffer, {
      knownItemsWithUnits,
      knownSuppliers
    });

    await this.enrichItemsWithCatalogMatch(data);

    const comparison = this.repo.compareWithHistory(data);

    const { invoiceId } = this.repo.saveInvoice(data, {
      userId: input.userId,
      messageId: input.messageId,
      photoFileId: input.photoFileId,
      modelUsed: data.model_used
    });

    let localPhotoPath: string | undefined;
    try {
      localPhotoPath = path.resolve(this.photosDir, `${invoiceId}.jpg`);
      fs.writeFileSync(localPhotoPath, input.photoBuffer);
      this.repo.updateLocalPhotoPath(invoiceId, localPhotoPath);
    } catch (err) {
      console.warn('[Workflow] Не удалось сохранить локальное фото:', err);
      localPhotoPath = undefined;
    }

    const cardText = formatInvoiceMessage(invoiceId, data, comparison);

    return {
      invoiceId,
      data,
      comparison,
      cardText,
      localPhotoPath,
      hasPhoto: true
    };
  }

  async processVoiceInvoice(input: {
    audioBuffer: Buffer;
    mimeType?: string;
    userId?: number;
    messageId?: number;
  }): Promise<ProcessInvoiceResult> {
    const knownItemsWithUnits = this.repo.getKnownItemsWithUnits(60);
    const knownSuppliers = this.repo.getKnownSuppliers(30);

    const data = await this.recognizer.recognizeVoice(input.audioBuffer, input.mimeType || 'audio/ogg', {
      knownItemsWithUnits,
      knownSuppliers
    });

    await this.enrichItemsWithCatalogMatch(data);

    const comparison = this.repo.compareWithHistory(data);

    const { invoiceId } = this.repo.saveInvoice(data, {
      userId: input.userId,
      messageId: input.messageId,
      modelUsed: data.model_used
    });

    const cardText = `🎙 <b>Голосовая накладная:</b>\n\n` + formatInvoiceMessage(invoiceId, data, comparison);

    return {
      invoiceId,
      data,
      comparison,
      cardText,
      hasPhoto: false
    };
  }

  toggleWarehouse(invoiceId: number): ToggleWarehouseResult {
    const domain = this.repo.getInvoice(invoiceId);
    if (!domain) {
      return { success: false, error: 'Накладная не найдена' };
    }

    if (domain.invoice.status === 'synced') {
      return { success: false, error: 'Накладная уже была создана в iiko и не может быть изменена.' };
    }

    this.repo.pushSnapshot(invoiceId, domain.data);
    const newWarehouse = this.repo.toggleWarehouse(invoiceId);
    if (!newWarehouse) {
      return { success: false, error: 'Не удалось переключить склад' };
    }

    const updated = this.repo.getInvoice(invoiceId);
    if (!updated) {
      return { success: false, error: 'Ошибка получения обновленной накладной' };
    }

    const comparison = this.repo.compareWithHistory(updated.data, 'beyni', invoiceId);
    const cardText = formatInvoiceMessage(invoiceId, updated.data, comparison);
    const hasPhoto = Boolean(updated.invoice.photo_file_id || updated.invoice.local_photo_path || this.getPhotoPath(invoiceId));

    return {
      success: true,
      newWarehouse,
      data: updated.data,
      comparison,
      cardText,
      hasPhoto
    };
  }

  applyTextEdit(invoiceId: number, text: string): EditInvoiceResult {
    const domain = this.repo.getInvoice(invoiceId);
    if (!domain) {
      return { success: false, message: 'Накладная не найдена в базе' };
    }

    const parseRes = parseInvoiceEditText(text, domain.data);
    if (!parseRes.success || !parseRes.data) {
      return { success: false, message: parseRes.message };
    }

    this.repo.pushSnapshot(invoiceId, domain.data);
    const saved = this.repo.updateInvoiceData(invoiceId, parseRes.data);
    if (!saved) {
      return { success: false, message: 'Не удалось сохранить изменения в базе' };
    }

    const comparison = this.repo.compareWithHistory(parseRes.data, 'beyni', invoiceId);
    const cardText = formatInvoiceMessage(invoiceId, parseRes.data, comparison);
    const editableText = formatEditableInvoice(parseRes.data);
    const hasPhoto = Boolean(domain.invoice.photo_file_id || domain.invoice.local_photo_path || this.getPhotoPath(invoiceId));

    return {
      success: true,
      message: parseRes.message,
      data: parseRes.data,
      comparison,
      cardText,
      editableText,
      hasPhoto
    };
  }

  applyDataEdit(invoiceId: number, data: InvoiceData): EditInvoiceResult {
    const domain = this.repo.getInvoice(invoiceId);
    if (!domain) {
      return { success: false, message: 'Накладная не найдена в базе' };
    }

    if (domain.invoice.status === 'synced') {
      return { success: false, message: 'Накладная уже была создана в iiko и не может быть изменена.' };
    }

    this.repo.pushSnapshot(invoiceId, domain.data);
    const saved = this.repo.updateInvoiceData(invoiceId, data);
    if (!saved) {
      return { success: false, message: 'Не удалось сохранить изменения в базе' };
    }

    const comparison = this.repo.compareWithHistory(data, 'beyni', invoiceId);
    const cardText = formatInvoiceMessage(invoiceId, data, comparison);
    const editableText = formatEditableInvoice(data);
    const hasPhoto = Boolean(domain.invoice.photo_file_id || domain.invoice.local_photo_path || this.getPhotoPath(invoiceId));

    return {
      success: true,
      message: 'Накладная успешно обновлена',
      data,
      comparison,
      cardText,
      editableText,
      hasPhoto
    };
  }

  async applyHybridEdit(invoiceId: number, text: string): Promise<EditInvoiceResult> {
    const domain = this.repo.getInvoice(invoiceId);
    if (!domain) {
      return { success: false, message: 'Накладная не найдена в базе' };
    }

    if (domain.invoice.status === 'synced') {
      return { success: false, message: 'Накладная уже была создана в iiko и не может быть изменена.' };
    }

    // 1. Deterministic fast regex parser first
    const regexRes = parseInvoiceEditText(text, domain.data);
    if (regexRes.success && regexRes.data) {
      this.repo.pushSnapshot(invoiceId, domain.data);
      const saved = this.repo.updateInvoiceData(invoiceId, regexRes.data);
      if (!saved) {
        return { success: false, message: 'Не удалось сохранить изменения в базе' };
      }

      const comparison = this.repo.compareWithHistory(regexRes.data, 'beyni', invoiceId);
      const cardText = formatInvoiceMessage(invoiceId, regexRes.data, comparison);
      const editableText = formatEditableInvoice(regexRes.data);
      const hasPhoto = Boolean(domain.invoice.photo_file_id || domain.invoice.local_photo_path || this.getPhotoPath(invoiceId));

      return {
        success: true,
        message: regexRes.message,
        data: regexRes.data,
        comparison,
        cardText,
        editableText,
        hasPhoto
      };
    }

    // 2. Free text natural language via Gemini
    try {
      const aiRes = await this.recognizer.recognizeEdit(domain.data, text);
      this.repo.pushSnapshot(invoiceId, domain.data);
      const saved = this.repo.updateInvoiceData(invoiceId, aiRes.data);
      if (!saved) {
        return { success: false, message: 'Не удалось сохранить изменения в базе' };
      }

      const comparison = this.repo.compareWithHistory(aiRes.data, 'beyni', invoiceId);
      const cardText = formatInvoiceMessage(invoiceId, aiRes.data, comparison);
      const editableText = formatEditableInvoice(aiRes.data);
      const hasPhoto = Boolean(domain.invoice.photo_file_id || domain.invoice.local_photo_path || this.getPhotoPath(invoiceId));

      return {
        success: true,
        message: `🤖 ${aiRes.summary}`,
        data: aiRes.data,
        comparison,
        cardText,
        editableText,
        hasPhoto
      };
    } catch (aiErr: any) {
      console.warn('[Workflow] Gemini edit fallback:', aiErr?.message);
      return {
        success: false,
        message: regexRes.message || 'Не удалось распознать формат правки.'
      };
    }
  }

  async applyVoiceEdit(invoiceId: number, audioBuffer: Buffer, mimeType = 'audio/ogg'): Promise<EditInvoiceResult> {
    const domain = this.repo.getInvoice(invoiceId);
    if (!domain) {
      return { success: false, message: 'Накладная не найдена в базе' };
    }

    if (domain.invoice.status === 'synced') {
      return { success: false, message: 'Накладная уже была создана в iiko и не может быть изменена.' };
    }

    try {
      const aiRes = await this.recognizer.recognizeVoiceEdit(domain.data, audioBuffer, mimeType);
      this.repo.pushSnapshot(invoiceId, domain.data);
      const saved = this.repo.updateInvoiceData(invoiceId, aiRes.data);
      if (!saved) {
        return { success: false, message: 'Не удалось сохранить изменения в базе' };
      }

      const comparison = this.repo.compareWithHistory(aiRes.data, 'beyni', invoiceId);
      const cardText = formatInvoiceMessage(invoiceId, aiRes.data, comparison);
      const editableText = formatEditableInvoice(aiRes.data);
      const hasPhoto = Boolean(domain.invoice.photo_file_id || domain.invoice.local_photo_path || this.getPhotoPath(invoiceId));

      return {
        success: true,
        message: `🎙 ${aiRes.summary}`,
        data: aiRes.data,
        comparison,
        cardText,
        editableText,
        hasPhoto
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Не удалось распознать голосовую правку: ${err.message}`
      };
    }
  }

  undoEdit(invoiceId: number): EditInvoiceResult {
    const domain = this.repo.getInvoice(invoiceId);
    if (!domain) {
      return { success: false, message: 'Накладная не найдена в базе' };
    }

    if (domain.invoice.status === 'synced') {
      return { success: false, message: 'Накладная уже была создана в iiko и не может быть изменена.' };
    }

    const prevData = this.repo.popSnapshot(invoiceId);
    if (!prevData) {
      return { success: false, message: 'Нет предыдущих сохраненных правок для отмены.' };
    }

    const saved = this.repo.updateInvoiceData(invoiceId, prevData);
    if (!saved) {
      return { success: false, message: 'Не удалось восстановить накладную в базе.' };
    }

    const comparison = this.repo.compareWithHistory(prevData, 'beyni', invoiceId);
    const cardText = formatInvoiceMessage(invoiceId, prevData, comparison);
    const editableText = formatEditableInvoice(prevData);
    const hasPhoto = Boolean(domain.invoice.photo_file_id || domain.invoice.local_photo_path || this.getPhotoPath(invoiceId));

    return {
      success: true,
      message: '↩️ Предыдущая правка отменена, данные возвращены!',
      data: prevData,
      comparison,
      cardText,
      editableText,
      hasPhoto
    };
  }

  canUndo(invoiceId: number): boolean {
    return this.repo.hasSnapshot(invoiceId);
  }

  saveProductMapping(rawName: string, iikoProductName: string, iikoProductId?: string): void {
    this.repo.saveProductMapping(rawName, iikoProductName, iikoProductId);
  }

  getProductMappings(): ProductMappingRecord[] {
    return this.repo.getAllProductMappings();
  }

  deleteItem(invoiceId: number, itemIndex: number): DeleteItemResult {
    const domain = this.repo.getInvoice(invoiceId);
    if (!domain) {
      return { success: false, error: 'Накладная не найдена' };
    }

    if (domain.invoice.status === 'synced') {
      return { success: false, error: 'Накладная уже была создана в iiko и не может быть изменена.' };
    }

    if (itemIndex < 0 || itemIndex >= domain.data.items.length) {
      return { success: false, error: 'Некорректный индекс позиции' };
    }

    const updatedItems = [...domain.data.items];
    const [removedItem] = updatedItems.splice(itemIndex, 1);

    const updatedData: InvoiceData = {
      ...domain.data,
      items: updatedItems
    };

    this.repo.pushSnapshot(invoiceId, domain.data);
    const saved = this.repo.updateInvoiceData(invoiceId, updatedData);
    if (!saved) {
      return { success: false, error: 'Не удалось обновить накладную в базе' };
    }

    const comparison = this.repo.compareWithHistory(updatedData, 'beyni', invoiceId);
    const cardText = formatInvoiceMessage(invoiceId, updatedData, comparison);
    const editableText = formatEditableInvoice(updatedData);
    const hasPhoto = Boolean(domain.invoice.photo_file_id || domain.invoice.local_photo_path || this.getPhotoPath(invoiceId));

    return {
      success: true,
      removedItem,
      data: updatedData,
      comparison,
      cardText,
      editableText,
      hasPhoto
    };
  }

  async confirmAndSync(invoiceId: number): Promise<SyncInvoiceResult> {
    const domain = this.repo.getInvoice(invoiceId);
    if (!domain) {
      return { success: false, message: 'Накладная не найдена в базе' };
    }

    if (domain.invoice.status === 'synced') {
      return {
        success: false,
        alreadySynced: true,
        message: 'Накладная уже была создана в iiko!'
      };
    }

    // Requirement: Block creation if any item is not matched to iiko nomenclature
    if (typeof this.iikoClient.getProducts === 'function') {
      try {
        const products = await this.iikoClient.getProducts();
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

    const { kitchen, household, isMixed } = partitionItemsByWarehouse(domain.data.items, domain.data.warehouse);

    if (isMixed) {
      // Create TWO separate draft invoices in iikoWeb sequentially to avoid cookie session invalidation
      const kitchenData: InvoiceData = {
        ...domain.data,
        warehouse: 'kitchen',
        items: kitchen,
        notes: (domain.data.notes ? domain.data.notes + ' ' : '') + '[Склад Кухня]'
      };

      const householdData: InvoiceData = {
        ...domain.data,
        warehouse: 'household',
        items: household,
        notes: (domain.data.notes ? domain.data.notes + ' ' : '') + '[Хоз склад]'
      };

      const resKitchen = await this.iikoClient.createInvoice(kitchenData);
      if (!resKitchen.success) {
        return {
          success: false,
          message: `Ошибка отправки накладной «Кухня» в iiko: ${resKitchen.message}`
        };
      }

      const resHousehold = await this.iikoClient.createInvoice(householdData);
      if (!resHousehold.success) {
        // Kitchen succeeded, household failed. Record partial sync to prevent duplicate creation of kitchen invoice.
        const partialDocNum = `🍽 Кухня: ${resKitchen.documentNumber || '—'} (Хоз склад: ошибка)`;
        this.repo.updateInvoiceStatus(invoiceId, 'synced', partialDocNum);
        return {
          success: false,
          documentNumber: resKitchen.documentNumber,
          isSplit: true,
          message: `Накладная «Кухня» успешно создана в iiko (#${resKitchen.documentNumber || '—'}), но отправка «Хоз склад» завершилась ошибкой: ${resHousehold.message}. Статус зафиксирован, чтобы избежать дублирования кухни.`
        };
      }

      const combinedDocNum = `🍽 Кухня: ${resKitchen.documentNumber || '—'}, 🏠 Хоз: ${resHousehold.documentNumber || '—'}`;
      this.repo.updateInvoiceStatus(invoiceId, 'synced', combinedDocNum);

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

    // Single category invoice
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

    const result = await this.iikoClient.createInvoice(singleData);
    if (result.success) {
      this.repo.updateInvoiceStatus(invoiceId, 'synced', result.documentNumber);
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
      message: result.message || 'Ошибка отправки в iiko'
    };
  }

  rejectInvoice(invoiceId: number): { success: boolean; error?: string } {
    const domain = this.repo.getInvoice(invoiceId);
    if (!domain) {
      return { success: false, error: 'Накладная не найдена' };
    }

    const ok = this.repo.updateInvoiceStatus(invoiceId, 'rejected');
    return { success: ok };
  }

  getInvoiceCard(invoiceId: number): {
    domain: InvoiceDomainRecord;
    comparison: HistoricalComparison;
    cardText: string;
    editableText: string;
    hasPhoto: boolean;
  } | null {
    const domain = this.repo.getInvoice(invoiceId);
    if (!domain) return null;

    const comparison = this.repo.compareWithHistory(domain.data, 'beyni', invoiceId);
    const cardText = formatInvoiceMessage(invoiceId, domain.data, comparison);
    const editableText = formatEditableInvoice(domain.data);
    const hasPhoto = Boolean(domain.invoice.photo_file_id || domain.invoice.local_photo_path || this.getPhotoPath(invoiceId));

    return {
      domain,
      comparison,
      cardText,
      editableText,
      hasPhoto
    };
  }

  getPhotoPath(invoiceId: number): string | null {
    const domain = this.repo.getInvoice(invoiceId);
    if (domain?.invoice.local_photo_path && fs.existsSync(domain.invoice.local_photo_path)) {
      return domain.invoice.local_photo_path;
    }
    const p = path.resolve(this.photosDir, `${invoiceId}.jpg`);
    if (fs.existsSync(p)) {
      return p;
    }
    return null;
  }

  saveEditSession(userId: number, session: {
    invoiceId: number;
    cardMessageId: number;
    chatId: number;
    editPromptMessageId?: number;
  }): void {
    this.repo.saveEditSession(userId, session);
  }

  getEditSession(userId: number): {
    invoiceId: number;
    cardMessageId: number;
    chatId: number;
    editPromptMessageId?: number;
  } | null {
    return this.repo.getEditSession(userId);
  }

  deleteEditSession(userId: number): boolean {
    return this.repo.deleteEditSession(userId);
  }

  updateInvoiceTelegramMessage(invoiceId: number, chatId: number, cardMessageId: number): boolean {
    return this.repo.updateInvoiceTelegramMessage(invoiceId, chatId, cardMessageId);
  }

  getLatestInvoice(status?: 'pending' | 'confirmed' | 'rejected' | 'synced'): InvoiceDomainRecord | null {
    return this.repo.getLatestInvoice(status);
  }

  getRecentInvoicesWithData(limit = 10) {
    return this.repo.getRecentInvoicesWithData(limit);
  }
}
