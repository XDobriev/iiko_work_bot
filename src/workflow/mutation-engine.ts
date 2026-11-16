import { InvoicesRepository } from '../db/invoices.repo.js';
import { GeminiInvoiceRecognizer } from '../gemini/recognizer.js';
import {
  InvoiceData,
  InvoiceItem,
  HistoricalComparison,
  WarehouseType,
  InvoiceDomainRecord,
  InvoiceDataSchema
} from '../types/index.js';
import { parseInvoiceEditText, formatEditableInvoice } from '../bot/parser.js';
import { InvoicePresentationAdapter } from '../presentation/telegram-adapter.js';
import { classifyItemWarehouse } from './warehouse-classifier.js';

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

export interface ToggleWarehouseResult {
  success: boolean;
  newWarehouse?: WarehouseType;
  data?: InvoiceData;
  comparison?: HistoricalComparison;
  cardText?: string;
  hasPhoto?: boolean;
  error?: string;
}

export interface MutationEngineDeps {
  repo: InvoicesRepository;
  recognizer: GeminiInvoiceRecognizer;
  presenter: InvoicePresentationAdapter;
  photosDir: string;
  isSyncInProgress: (invoiceId: number) => boolean;
  getPhotoPath?: (invoiceId: number) => string | undefined;
}

export function haveItemsChanged(a: InvoiceItem[], b: InvoiceItem[]): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    const itemA = a[i];
    const itemB = b[i];
    if (
      itemA.name !== itemB.name ||
      itemA.qty !== itemB.qty ||
      itemA.price !== itemB.price ||
      (itemA.warehouse || 'kitchen') !== (itemB.warehouse || 'kitchen') ||
      (itemA.unit || 'шт') !== (itemB.unit || 'шт') ||
      (itemA.iiko_product_name || '') !== (itemB.iiko_product_name || '')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Unified mutation pipeline engine for invoices.
 * Enforces schema invariants, recalculates totals and row sums uniformly,
 * manages rollback snapshots, and decouples mutations from transport and presentation.
 */
export class InvoiceMutationEngine {
  constructor(private deps: MutationEngineDeps) {}

  /**
   * Enforces schema invariants and recalculates row sums.
   */
  public sanitizeAndRecalculate(data: InvoiceData): InvoiceData {
    const fallbackWh = data.warehouse || 'kitchen';
    const sanitizedItems = (data.items || []).map(item => {
      const qty = typeof item.qty === 'number' && !isNaN(item.qty) ? Math.max(0, item.qty) : 0;
      const price = typeof item.price === 'number' && !isNaN(item.price) ? Math.max(0, item.price) : 0;
      const sum = Math.round(qty * price * 100) / 100;
      const warehouse = item.warehouse || classifyItemWarehouse(item.name, undefined, fallbackWh);
      const unit = item.unit || 'шт';
      return {
        ...item,
        qty,
        price,
        sum,
        warehouse,
        unit
      };
    });

    const candidate = {
      ...data,
      warehouse: fallbackWh,
      items: sanitizedItems
    };

    const parsed = InvoiceDataSchema.safeParse(candidate);
    if (parsed.success) {
      return parsed.data;
    }

    return candidate;
  }

  /**
   * Calculates overall calculated sum of all line items.
   */
  public calculateTotal(data: InvoiceData): number {
    return Math.round(
      (data.items || []).reduce((acc, it) => acc + (it.sum || it.qty * it.price), 0) * 100
    ) / 100;
  }

  private hasPhoto(invoiceId: number, domain: InvoiceDomainRecord): boolean {
    return Boolean(
      domain.invoice.photo_file_id ||
      domain.invoice.local_photo_path ||
      (this.deps.getPhotoPath && this.deps.getPhotoPath(invoiceId))
    );
  }

  private checkGuard(invoiceId: number): { allowed: true; domain: InvoiceDomainRecord } | { allowed: false; error: string } {
    if (this.deps.isSyncInProgress(invoiceId)) {
      return {
        allowed: false,
        error: 'Накладная сейчас отправляется в iiko. Изменения заблокированы.'
      };
    }

    const domain = this.deps.repo.getInvoice(invoiceId);
    if (!domain) {
      return {
        allowed: false,
        error: 'Накладная не найдена в базе'
      };
    }

    if (domain.invoice.status === 'synced') {
      return {
        allowed: false,
        error: 'Накладная уже была создана в iiko и не может быть изменена.'
      };
    }

    return { allowed: true, domain };
  }

  /**
   * Applies direct structured data changes (e.g. from Telegram Mini App).
   */
  public applyData(invoiceId: number, data: InvoiceData): EditInvoiceResult {
    const guard = this.checkGuard(invoiceId);
    if (!guard.allowed) {
      return { success: false, message: guard.error };
    }
    const { domain } = guard;

    const sanitized = this.sanitizeAndRecalculate(data);

    this.deps.repo.pushSnapshot(invoiceId, domain.data);
    const saved = this.deps.repo.updateInvoiceData(invoiceId, sanitized);
    if (!saved) {
      return { success: false, message: 'Не удалось сохранить изменения в базе' };
    }

    const comparison = this.deps.repo.compareWithHistory(sanitized, 'beyni', invoiceId);
    const cardText = this.deps.presenter.formatCard(invoiceId, sanitized, comparison);
    const editableText = this.deps.presenter.formatEditable(sanitized);
    const hasPhoto = this.hasPhoto(invoiceId, domain);

    return {
      success: true,
      message: 'Накладная успешно обновлена',
      data: sanitized,
      comparison,
      cardText,
      editableText,
      hasPhoto
    };
  }

  /**
   * Applies deterministic regex/text command edit.
   */
  public applyText(invoiceId: number, text: string): EditInvoiceResult {
    const guard = this.checkGuard(invoiceId);
    if (!guard.allowed) {
      return { success: false, message: guard.error };
    }
    const { domain } = guard;

    const parseRes = parseInvoiceEditText(text, domain.data);
    if (!parseRes.success || !parseRes.data) {
      return { success: false, message: parseRes.message };
    }

    const sanitized = this.sanitizeAndRecalculate(parseRes.data);

    this.deps.repo.pushSnapshot(invoiceId, domain.data);
    const saved = this.deps.repo.updateInvoiceData(invoiceId, sanitized);
    if (!saved) {
      return { success: false, message: 'Не удалось сохранить изменения в базе' };
    }

    const comparison = this.deps.repo.compareWithHistory(sanitized, 'beyni', invoiceId);
    const cardText = this.deps.presenter.formatCard(invoiceId, sanitized, comparison);
    const editableText = this.deps.presenter.formatEditable(sanitized);
    const hasPhoto = this.hasPhoto(invoiceId, domain);

    return {
      success: true,
      message: parseRes.message,
      data: sanitized,
      comparison,
      cardText,
      editableText,
      hasPhoto
    };
  }

  /**
   * Applies hybrid edit: fast regex first, with fallback to Gemini natural language parser.
   */
  public async applyHybrid(invoiceId: number, text: string): Promise<EditInvoiceResult> {
    const guard = this.checkGuard(invoiceId);
    if (!guard.allowed) {
      return { success: false, message: guard.error };
    }
    const { domain } = guard;

    // 1. Fast deterministic regex parser first
    const regexRes = parseInvoiceEditText(text, domain.data);
    if (regexRes.success && regexRes.data) {
      const sanitized = this.sanitizeAndRecalculate(regexRes.data);
      this.deps.repo.pushSnapshot(invoiceId, domain.data);
      const saved = this.deps.repo.updateInvoiceData(invoiceId, sanitized);
      if (!saved) {
        return { success: false, message: 'Не удалось сохранить изменения в базе' };
      }

      const comparison = this.deps.repo.compareWithHistory(sanitized, 'beyni', invoiceId);
      const cardText = this.deps.presenter.formatCard(invoiceId, sanitized, comparison);
      const editableText = this.deps.presenter.formatEditable(sanitized);
      const hasPhoto = this.hasPhoto(invoiceId, domain);

      return {
        success: true,
        message: regexRes.message,
        data: sanitized,
        comparison,
        cardText,
        editableText,
        hasPhoto
      };
    }

    // Deterministic syntax errors return immediately without querying Gemini
    if (regexRes.isDeterministicError) {
      return {
        success: false,
        message: regexRes.message
      };
    }

    // 2. Free text natural language via Gemini
    try {
      const aiRes = await this.deps.recognizer.recognizeEdit(domain.data, text);
      const sanitized = this.sanitizeAndRecalculate(aiRes.data);
      const hasChanges =
        haveItemsChanged(sanitized.items, domain.data.items) ||
        sanitized.supplier !== domain.data.supplier ||
        sanitized.warehouse !== domain.data.warehouse ||
        sanitized.total_written !== domain.data.total_written ||
        sanitized.notes !== domain.data.notes;

      if (!hasChanges) {
        return {
          success: false,
          message: aiRes.summary
            ? `ИИ: ${aiRes.summary}\n(Изменения не применились к накладной)`
            : 'Не удалось распознать изменения в тексте. Попробуйте написать точнее.'
        };
      }

      this.deps.repo.pushSnapshot(invoiceId, domain.data);
      const saved = this.deps.repo.updateInvoiceData(invoiceId, sanitized);
      if (!saved) {
        return { success: false, message: 'Не удалось сохранить изменения в базе' };
      }

      const comparison = this.deps.repo.compareWithHistory(sanitized, 'beyni', invoiceId);
      const cardText = this.deps.presenter.formatCard(invoiceId, sanitized, comparison);
      const editableText = this.deps.presenter.formatEditable(sanitized);
      const hasPhoto = this.hasPhoto(invoiceId, domain);

      return {
        success: true,
        message: `🤖 ${aiRes.summary || 'Правка применена через ИИ'}`,
        data: sanitized,
        comparison,
        cardText,
        editableText,
        hasPhoto
      };
    } catch {
      return {
        success: false,
        message: regexRes.message || 'Не удалось распознать формат правки.'
      };
    }
  }

  /**
   * Applies voice audio transcription & mutation.
   */
  public async applyVoice(
    invoiceId: number,
    audioBuffer: Buffer,
    mimeType = 'audio/ogg'
  ): Promise<EditInvoiceResult> {
    const guard = this.checkGuard(invoiceId);
    if (!guard.allowed) {
      return { success: false, message: guard.error };
    }
    const { domain } = guard;

    try {
      const aiRes = await this.deps.recognizer.recognizeVoiceEdit(domain.data, audioBuffer, mimeType);
      const sanitized = this.sanitizeAndRecalculate(aiRes.data);
      const hasChanges =
        haveItemsChanged(sanitized.items, domain.data.items) ||
        sanitized.supplier !== domain.data.supplier ||
        sanitized.warehouse !== domain.data.warehouse ||
        sanitized.total_written !== domain.data.total_written ||
        sanitized.notes !== domain.data.notes;

      if (!hasChanges) {
        return {
          success: false,
          message: aiRes.summary
            ? `Голос: ${aiRes.summary}\n(Изменения не применились к накладной)`
            : 'Не удалось распознать изменения в голосовом сообщении. Попробуйте наговорить точнее.'
        };
      }

      this.deps.repo.pushSnapshot(invoiceId, domain.data);
      const saved = this.deps.repo.updateInvoiceData(invoiceId, sanitized);
      if (!saved) {
        return { success: false, message: 'Не удалось сохранить изменения в базе' };
      }

      const comparison = this.deps.repo.compareWithHistory(sanitized, 'beyni', invoiceId);
      const cardText = this.deps.presenter.formatCard(invoiceId, sanitized, comparison);
      const editableText = this.deps.presenter.formatEditable(sanitized);
      const hasPhoto = this.hasPhoto(invoiceId, domain);

      return {
        success: true,
        message: `🎙 ${aiRes.summary}`,
        data: sanitized,
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

  /**
   * Deletes a specific line item from the invoice.
   */
  public deleteItem(invoiceId: number, itemIndex: number): DeleteItemResult {
    const guard = this.checkGuard(invoiceId);
    if (!guard.allowed) {
      return { success: false, error: guard.error };
    }
    const { domain } = guard;

    if (itemIndex < 0 || itemIndex >= domain.data.items.length) {
      return { success: false, error: 'Некорректный индекс позиции' };
    }

    const updatedItems = [...domain.data.items];
    const [removedItem] = updatedItems.splice(itemIndex, 1);

    const updatedData: InvoiceData = this.sanitizeAndRecalculate({
      ...domain.data,
      items: updatedItems
    });

    this.deps.repo.pushSnapshot(invoiceId, domain.data);
    const saved = this.deps.repo.updateInvoiceData(invoiceId, updatedData);
    if (!saved) {
      return { success: false, error: 'Не удалось обновить накладную в базе' };
    }

    const comparison = this.deps.repo.compareWithHistory(updatedData, 'beyni', invoiceId);
    const cardText = this.deps.presenter.formatCard(invoiceId, updatedData, comparison);
    const editableText = this.deps.presenter.formatEditable(updatedData);
    const hasPhoto = this.hasPhoto(invoiceId, domain);

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

  /**
   * Toggles warehouse between kitchen and household for the entire invoice.
   */
  public toggleWarehouse(invoiceId: number): ToggleWarehouseResult {
    const guard = this.checkGuard(invoiceId);
    if (!guard.allowed) {
      return { success: false, error: guard.error };
    }
    const { domain } = guard;

    this.deps.repo.pushSnapshot(invoiceId, domain.data);
    const newWarehouse = this.deps.repo.toggleWarehouse(invoiceId);
    if (!newWarehouse) {
      return { success: false, error: 'Не удалось переключить склад' };
    }

    const updated = this.deps.repo.getInvoice(invoiceId);
    if (!updated) {
      return { success: false, error: 'Ошибка получения обновленной накладной' };
    }

    const comparison = this.deps.repo.compareWithHistory(updated.data, 'beyni', invoiceId);
    const cardText = this.deps.presenter.formatCard(invoiceId, updated.data, comparison);
    const hasPhoto = this.hasPhoto(invoiceId, updated);

    return {
      success: true,
      newWarehouse,
      data: updated.data,
      comparison,
      cardText,
      hasPhoto
    };
  }

  /**
   * Rolls back invoice data to the most recent snapshot.
   */
  public undo(invoiceId: number): EditInvoiceResult {
    const guard = this.checkGuard(invoiceId);
    if (!guard.allowed) {
      return { success: false, message: guard.error };
    }
    const { domain } = guard;

    const prevData = this.deps.repo.popSnapshot(invoiceId);
    if (!prevData) {
      return { success: false, message: 'Нет предыдущих сохраненных правок для отмены.' };
    }

    const sanitized = this.sanitizeAndRecalculate(prevData);
    const saved = this.deps.repo.updateInvoiceData(invoiceId, sanitized);
    if (!saved) {
      return { success: false, message: 'Не удалось восстановить накладную в базе.' };
    }

    const comparison = this.deps.repo.compareWithHistory(sanitized, 'beyni', invoiceId);
    const cardText = this.deps.presenter.formatCard(invoiceId, sanitized, comparison);
    const editableText = this.deps.presenter.formatEditable(sanitized);
    const hasPhoto = this.hasPhoto(invoiceId, domain);

    return {
      success: true,
      message: '↩️ Предыдущая правка отменена, данные возвращены!',
      data: sanitized,
      comparison,
      cardText,
      editableText,
      hasPhoto
    };
  }
}
