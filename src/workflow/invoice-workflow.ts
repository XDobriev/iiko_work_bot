import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { InvoicesRepository } from '../db/invoices.repo.js';
import { GeminiInvoiceRecognizer } from '../gemini/recognizer.js';
import { IikoClient, IikoCreateInvoiceResult } from '../iiko/client.js';
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
  isMock?: boolean;
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

    const comparison = this.repo.compareWithHistory(data);

    const { invoiceId } = this.repo.saveInvoice(data, {
      userId: input.userId,
      messageId: input.messageId,
      photoFileId: input.photoFileId
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

    const comparison = this.repo.compareWithHistory(data);

    const { invoiceId } = this.repo.saveInvoice(data, {
      userId: input.userId,
      messageId: input.messageId
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

    const newWarehouse = this.repo.toggleWarehouse(invoiceId);
    if (!newWarehouse) {
      return { success: false, error: 'Не удалось переключить склад' };
    }

    const updated = this.repo.getInvoice(invoiceId);
    if (!updated) {
      return { success: false, error: 'Ошибка получения обновленной накладной' };
    }

    const comparison = this.repo.compareWithHistory(updated.data);
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

    const saved = this.repo.updateInvoiceData(invoiceId, parseRes.data);
    if (!saved) {
      return { success: false, message: 'Не удалось сохранить изменения в базе' };
    }

    const comparison = this.repo.compareWithHistory(parseRes.data);
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

    const saved = this.repo.updateInvoiceData(invoiceId, data);
    if (!saved) {
      return { success: false, message: 'Не удалось сохранить изменения в базе' };
    }

    const comparison = this.repo.compareWithHistory(data);
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

    if (itemIndex < 0 || itemIndex >= domain.data.items.length) {
      return { success: false, error: 'Некорректный индекс позиции' };
    }

    const updatedItems = [...domain.data.items];
    const [removedItem] = updatedItems.splice(itemIndex, 1);

    const updatedData: InvoiceData = {
      ...domain.data,
      items: updatedItems
    };

    const saved = this.repo.updateInvoiceData(invoiceId, updatedData);
    if (!saved) {
      return { success: false, error: 'Не удалось обновить накладную в базе' };
    }

    const comparison = this.repo.compareWithHistory(updatedData);
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

    const result = await this.iikoClient.createInvoice(domain.data);
    if (result.success) {
      this.repo.updateInvoiceStatus(invoiceId, 'synced', result.documentNumber);
      return {
        success: true,
        documentNumber: result.documentNumber,
        isMock: result.isMock,
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

    const comparison = this.repo.compareWithHistory(domain.data);
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
}
