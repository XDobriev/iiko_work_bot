import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { InvoicesRepository } from '../db/invoices.repo.js';
import { GeminiInvoiceRecognizer, RecognizerProgress } from '../gemini/recognizer.js';
import { IikoClient } from '../iiko/client.js';
import {
  CatalogProduct,
  ProductCatalogMatcher,
  MatchStatus,
  ProductSuggestion
} from '../iiko/matcher.js';
import {
  InvoiceData,
  HistoricalComparison,
  WarehouseType,
  InvoiceDomainRecord,
  ProductMappingRecord
} from '../types/index.js';
import { normalizeClassifierText } from './warehouse-classifier.js';
import {
  IIkoAccountingGateway,
  LiveIikoAccountingGateway,
  GatewaySyncResult
} from '../iiko/accounting-gateway.js';
import { InvoiceMutationEngine } from './mutation-engine.js';
import type {
  EditInvoiceResult,
  DeleteItemResult,
  ToggleWarehouseResult
} from './mutation-engine.js';
import {
  InvoicePresentationAdapter,
  TelegramPresentationAdapter
} from '../presentation/telegram-adapter.js';

export type { EditInvoiceResult, DeleteItemResult, ToggleWarehouseResult };

export interface InvoiceWorkflowDeps {
  repo?: InvoicesRepository;
  recognizer?: GeminiInvoiceRecognizer;
  iikoClient?: IikoClient;
  iikoGateway?: IIkoAccountingGateway;
  presenter?: InvoicePresentationAdapter;
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

export type SyncInvoiceResult = GatewaySyncResult;

/**
 * Headless coordinator for invoice lifecycle:
 * - Ingestion & OCR (photo, voice)
 * - Mutation pipelines (delegated to InvoiceMutationEngine)
 * - Synchronization & nomenclature resolution (delegated to IIkoAccountingGateway)
 * - Persistence & sessions (InvoicesRepository)
 * - Presentation (InvoicePresentationAdapter)
 */
export class InvoiceWorkflow {
  private repo: InvoicesRepository;
  private recognizer: GeminiInvoiceRecognizer;
  private iikoGateway: IIkoAccountingGateway;
  private mutationEngine: InvoiceMutationEngine;
  private presenter: InvoicePresentationAdapter;
  private photosDir: string;
  private inFlightSyncs = new Set<number>();

  constructor(deps: InvoiceWorkflowDeps = {}) {
    this.repo = deps.repo || new InvoicesRepository();
    this.recognizer = deps.recognizer || new GeminiInvoiceRecognizer();
    this.photosDir = deps.photosDir || path.resolve(path.dirname(config.db.path), 'photos');
    this.presenter = deps.presenter || new TelegramPresentationAdapter();

    if (deps.iikoGateway) {
      this.iikoGateway = deps.iikoGateway;
    } else if (deps.iikoClient) {
      this.iikoGateway = new LiveIikoAccountingGateway({ client: deps.iikoClient, repo: this.repo });
    } else {
      this.iikoGateway = new LiveIikoAccountingGateway({ repo: this.repo });
    }

    this.mutationEngine = new InvoiceMutationEngine({
      repo: this.repo,
      recognizer: this.recognizer,
      presenter: this.presenter,
      photosDir: this.photosDir,
      isSyncInProgress: (id: number) => this.isSyncInProgress(id),
      getPhotoPath: (id: number) => this.getPhotoPath(id) || undefined
    });

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

  getPresenter(): InvoicePresentationAdapter {
    return this.presenter;
  }

  getGateway(): IIkoAccountingGateway {
    return this.iikoGateway;
  }

  get iikoClient(): IikoClient | undefined {
    if (this.iikoGateway instanceof LiveIikoAccountingGateway) {
      return this.iikoGateway.getClient();
    }
    return undefined;
  }

  isSyncInProgress(invoiceId: number): boolean {
    return this.inFlightSyncs.has(invoiceId);
  }

  async getCatalogProducts(): Promise<CatalogProduct[]> {
    return this.iikoGateway.getProducts();
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

    const analysis = await this.iikoGateway.analyzeNomenclature(domain.data.items);
    return {
      items: analysis.items,
      hasUnmatched: analysis.hasUnmatched
    };
  }

  async processPhotoInvoice(input: {
    photoBuffer: Buffer;
    userId?: number;
    messageId?: number;
    photoFileId?: string;
    caption?: string;
    onProgress?: (progress: RecognizerProgress) => void;
  }): Promise<ProcessInvoiceResult> {
    const knownItemsWithUnits = this.repo.getKnownItemsWithUnits(60);
    const knownSuppliers = this.repo.getKnownSuppliers(30);

    const data = await this.recognizer.recognize(input.photoBuffer, {
      knownItemsWithUnits,
      knownSuppliers,
      userHint: input.caption?.trim(),
      onProgress: input.onProgress
    });

    if (input.caption) {
      const trimmedCaption = input.caption.trim();
      const normalizedCaption = normalizeClassifierText(trimmedCaption);
      const isExplicitHousehold = /(?:^|\s)(хоз\s*склад|склад\s*хоз|хозтовары|хоз|household)(?:$|\s)/i.test(normalizedCaption);
      const isExplicitKitchen = /(?:^|\s)(склад\s*кухня|кухня|kitchen)(?:$|\s)/i.test(normalizedCaption) && !normalizedCaption.includes('хоз');

      // Explicit warehouse override from caption
      if (isExplicitHousehold) {
        data.warehouse = 'household';
        for (const item of data.items) {
          if (!item.warehouse || item.warehouse === 'kitchen') {
            item.warehouse = 'household';
          }
        }
      } else if (isExplicitKitchen) {
        data.warehouse = 'kitchen';
      }

      // Explicit supplier override from caption (e.g. "Поставщик: Овощи" or "Поставщик: ИП Иванов")
      const suppMatch = trimmedCaption.match(/^поставщик\s*[:\-–]?\s*(.+)$/im);
      if (suppMatch && suppMatch[1].trim()) {
        data.supplier = suppMatch[1].trim();
      }
    }

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

    const cardText = this.presenter.formatCard(invoiceId, data, comparison);

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
    userHint?: string;
    onProgress?: (progress: RecognizerProgress) => void;
  }): Promise<ProcessInvoiceResult> {
    const knownItemsWithUnits = this.repo.getKnownItemsWithUnits(60);
    const knownSuppliers = this.repo.getKnownSuppliers(30);

    const data = await this.recognizer.recognizeVoice(input.audioBuffer, input.mimeType || 'audio/ogg', {
      knownItemsWithUnits,
      knownSuppliers,
      userHint: input.userHint?.trim(),
      onProgress: input.onProgress
    });

    await this.enrichItemsWithCatalogMatch(data);

    const comparison = this.repo.compareWithHistory(data);

    const { invoiceId } = this.repo.saveInvoice(data, {
      userId: input.userId,
      messageId: input.messageId,
      modelUsed: data.model_used
    });

    const cardText = this.presenter.formatVoiceCard
      ? this.presenter.formatVoiceCard(invoiceId, data, comparison)
      : this.presenter.formatCard(invoiceId, data, comparison);

    return {
      invoiceId,
      data,
      comparison,
      cardText,
      hasPhoto: false
    };
  }

  toggleWarehouse(invoiceId: number): ToggleWarehouseResult {
    return this.mutationEngine.toggleWarehouse(invoiceId);
  }

  applyTextEdit(invoiceId: number, text: string): EditInvoiceResult {
    return this.mutationEngine.applyText(invoiceId, text);
  }

  applyDataEdit(invoiceId: number, data: InvoiceData): EditInvoiceResult {
    return this.mutationEngine.applyData(invoiceId, data);
  }

  async applyHybridEdit(invoiceId: number, text: string): Promise<EditInvoiceResult> {
    return this.mutationEngine.applyHybrid(invoiceId, text);
  }

  async applyVoiceEdit(invoiceId: number, audioBuffer: Buffer, mimeType = 'audio/ogg'): Promise<EditInvoiceResult> {
    return this.mutationEngine.applyVoice(invoiceId, audioBuffer, mimeType);
  }

  undoEdit(invoiceId: number): EditInvoiceResult {
    return this.mutationEngine.undo(invoiceId);
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
    return this.mutationEngine.deleteItem(invoiceId, itemIndex);
  }

  async confirmAndSync(invoiceId: number): Promise<SyncInvoiceResult> {
    if (this.inFlightSyncs.has(invoiceId)) {
      return {
        success: false,
        alreadySynced: false,
        inProgress: true,
        message: 'Накладная уже отправляется в iikoWeb. Пожалуйста, дождитесь завершения запроса.'
      };
    }

    this.inFlightSyncs.add(invoiceId);
    try {
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

      const result = await this.iikoGateway.syncInvoice(domain);
      if (result.success) {
        this.repo.updateInvoiceStatus(invoiceId, 'synced', result.documentNumber);
      } else if (result.isSplit && result.documentNumber) {
        // Kitchen succeeded, household failed. Record partial sync to avoid duplicate creation on retry.
        const partialDocNum = `🍽 Кухня: ${result.documentNumber} (Хоз склад: ошибка)`;
        this.repo.updateInvoiceStatus(invoiceId, 'synced', partialDocNum);
      }

      return result;
    } finally {
      this.inFlightSyncs.delete(invoiceId);
    }
  }

  rejectInvoice(invoiceId: number): { success: boolean; error?: string } {
    if (this.isSyncInProgress(invoiceId)) {
      return { success: false, error: 'Накладная сейчас отправляется в iiko. Отклонение заблокировано.' };
    }

    const domain = this.repo.getInvoice(invoiceId);
    if (!domain) {
      return { success: false, error: 'Накладная не найдена' };
    }

    if (domain.invoice.status === 'synced') {
      return { success: false, error: 'Накладная уже была создана в iiko и не может быть отклонена.' };
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
    const cardText = this.presenter.formatCard(invoiceId, domain.data, comparison);
    const editableText = this.presenter.formatEditable(domain.data);
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
