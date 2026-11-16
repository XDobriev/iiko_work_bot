import { InvoiceWorkflow, ProcessInvoiceResult } from '../workflow/invoice-workflow.js';
import { RecognizerProgress } from '../gemini/recognizer.js';
import { escapeHtml } from './formatter.js';

export type InvoiceQueueTaskType = 'photo' | 'voice';

export interface InvoiceQueueTask {
  id: string;
  type: InvoiceQueueTaskType;
  chatId: number;
  userId?: number;
  messageId: number;
  photoBuffer?: Buffer;
  photoFileId?: string;
  caption?: string;
  audioBuffer?: Buffer;
  audioMimeType?: string;
  statusMessageId?: number;
  statusMessagePromise?: Promise<number | undefined>;
  batchIndex: number;
  enqueuedAt: number;
  resolve: (result: ProcessInvoiceResult) => void;
  reject: (error: any) => void;
}

export interface InvoiceQueueTelegramApi {
  sendMessage(chatId: number, text: string, other?: any): Promise<{ message_id: number }>;
  editMessageText(chatId: number, messageId: number, text: string, other?: any): Promise<any>;
  deleteMessage(chatId: number, messageId: number): Promise<any>;
}

export interface InvoiceQueueOptions {
  workflow: InvoiceWorkflow;
  api: InvoiceQueueTelegramApi;
  interTaskDelayMs?: number; // default: 2500ms (RPM protection)
  progressIntervalMs?: number; // default: 4000ms (Telegram UI tick)
  onInvoiceReady?: (task: InvoiceQueueTask, result: ProcessInvoiceResult) => Promise<void>;
  onInvoiceError?: (task: InvoiceQueueTask, error: any) => Promise<void>;
}

/**
 * Sequential FIFO Processing Queue for invoices.
 * Ensures Google API requests are executed strictly sequentially (concurrency: 1)
 * with a 2-3s RPM guard pause between tasks, instant user queue confirmation,
 * live progress updates in Telegram, and clean message lifecycle.
 */
export class InvoiceQueue {
  private queue: InvoiceQueueTask[] = [];
  private isProcessing = false;
  private batchCounter = 0;
  private workflow: InvoiceWorkflow;
  private api: InvoiceQueueTelegramApi;
  private interTaskDelayMs: number;
  private progressIntervalMs: number;
  private onInvoiceReady?: (task: InvoiceQueueTask, result: ProcessInvoiceResult) => Promise<void>;
  private onInvoiceError?: (task: InvoiceQueueTask, error: any) => Promise<void>;

  constructor(options: InvoiceQueueOptions) {
    this.workflow = options.workflow;
    this.api = options.api;
    this.interTaskDelayMs = options.interTaskDelayMs ?? 2500;
    this.progressIntervalMs = options.progressIntervalMs ?? 4000;
    this.onInvoiceReady = options.onInvoiceReady;
    this.onInvoiceError = options.onInvoiceError;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  getBatchCounter(): number {
    return this.batchCounter;
  }

  isBusy(): boolean {
    return this.isProcessing;
  }

  /**
   * Enqueues photo invoice for sequential thoughtful recognition.
   */
  async enqueuePhoto(input: {
    chatId: number;
    userId?: number;
    messageId: number;
    photoBuffer: Buffer;
    photoFileId?: string;
    caption?: string;
  }): Promise<ProcessInvoiceResult> {
    const isFirstInIdleQueue = !this.isProcessing && this.queue.length === 0;
    this.batchCounter++;
    const batchIndex = this.batchCounter;

    let resolveTask!: (res: ProcessInvoiceResult) => void;
    let rejectTask!: (err: any) => void;
    const promise = new Promise<ProcessInvoiceResult>((res, rej) => {
      resolveTask = res;
      rejectTask = rej;
    });

    const task: InvoiceQueueTask = {
      id: `photo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type: 'photo',
      chatId: input.chatId,
      userId: input.userId,
      messageId: input.messageId,
      photoBuffer: input.photoBuffer,
      photoFileId: input.photoFileId,
      caption: input.caption,
      batchIndex,
      enqueuedAt: Date.now(),
      resolve: resolveTask,
      reject: rejectTask
    };

    // If queue is busy, notify user immediately about queue position
    if (!isFirstInIdleQueue) {
      const pos = batchIndex;
      const total = this.batchCounter;
      task.statusMessagePromise = this.api.sendMessage(
        task.chatId,
        `📥 Накладная добавлена в очередь (#${pos} из ${total}). Обработка идет по порядку...`,
        { parse_mode: 'HTML' }
      ).then(msg => {
        task.statusMessageId = msg.message_id;
        return msg.message_id;
      }).catch(err => {
        console.warn('[InvoiceQueue] Не удалось отправить сообщение об очереди:', err);
        return undefined;
      });
    }

    // Always push synchronously into queue to guarantee FIFO order
    this.queue.push(task);
    this.ensureWorkerRunning();

    return promise;
  }

  /**
   * Enqueues voice invoice for sequential recognition.
   */
  async enqueueVoice(input: {
    chatId: number;
    userId?: number;
    messageId: number;
    audioBuffer: Buffer;
    audioMimeType?: string;
  }): Promise<ProcessInvoiceResult> {
    const isFirstInIdleQueue = !this.isProcessing && this.queue.length === 0;
    this.batchCounter++;
    const batchIndex = this.batchCounter;

    let resolveTask!: (res: ProcessInvoiceResult) => void;
    let rejectTask!: (err: any) => void;
    const promise = new Promise<ProcessInvoiceResult>((res, rej) => {
      resolveTask = res;
      rejectTask = rej;
    });

    const task: InvoiceQueueTask = {
      id: `voice_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type: 'voice',
      chatId: input.chatId,
      userId: input.userId,
      messageId: input.messageId,
      audioBuffer: input.audioBuffer,
      audioMimeType: input.audioMimeType,
      batchIndex,
      enqueuedAt: Date.now(),
      resolve: resolveTask,
      reject: rejectTask
    };

    if (!isFirstInIdleQueue) {
      const pos = batchIndex;
      const total = this.batchCounter;
      task.statusMessagePromise = this.api.sendMessage(
        task.chatId,
        `📥 Накладная добавлена в очередь (#${pos} из ${total}). Обработка идет по порядку...`,
        { parse_mode: 'HTML' }
      ).then(msg => {
        task.statusMessageId = msg.message_id;
        return msg.message_id;
      }).catch(err => {
        console.warn('[InvoiceQueue] Не удалось отправить сообщение об очереди:', err);
        return undefined;
      });
    }

    this.queue.push(task);
    this.ensureWorkerRunning();

    return promise;
  }

  private ensureWorkerRunning(): void {
    if (this.isProcessing) return;
    this.isProcessing = true;
    this.runWorkerLoop().catch(err => {
      console.error('[InvoiceQueue] Критическая ошибка worker loop:', err);
    });
  }

  private async runWorkerLoop(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift()!;
        try {
          await this.processSingleTask(task);
        } catch (taskErr) {
          console.error(`[InvoiceQueue] Ошибка при обработке накладной #${task.batchIndex}:`, taskErr);
        }

        if (this.queue.length > 0) {
          console.log(`[InvoiceQueue] ⏸ Защитная пауза ${this.interTaskDelayMs}мс перед следующей накладной (RPM Guard)...`);
          await new Promise(r => setTimeout(r, this.interTaskDelayMs));
        }
      }
    } finally {
      this.isProcessing = false;
      if (this.queue.length > 0) {
        this.ensureWorkerRunning();
      } else {
        this.batchCounter = 0;
        console.log('[InvoiceQueue] ✅ Очередь пуста, все накладные обработаны.');
      }
    }
  }

  private async processSingleTask(task: InvoiceQueueTask): Promise<void> {
    const isPhoto = task.type === 'photo';
    const actionText = isPhoto ? 'Разбираю рукописный текст нейросетью' : 'Слушаю голосовую накладную через нейросеть';

    if (task.statusMessagePromise && !task.statusMessageId) {
      task.statusMessageId = await task.statusMessagePromise;
    }

    const initialProcessingText = `⏳ [Накладная ${task.batchIndex} из ${this.batchCounter}] ${actionText}... (0 сек, соединение активно)`;
    if (task.statusMessageId) {
      await this.safeEditMessage(task.chatId, task.statusMessageId, initialProcessingText);
    } else {
      try {
        const msg = await this.api.sendMessage(task.chatId, initialProcessingText, { parse_mode: 'HTML' });
        task.statusMessageId = msg.message_id;
      } catch (err) {
        console.warn('[InvoiceQueue] Не удалось отправить стартовое сообщение задачи:', err);
      }
    }

    const startTime = Date.now();
    let lastHeartbeatTime = Date.now();
    let isTaskDone = false;

    const progressTimer = setInterval(async () => {
      if (isTaskDone || !task.statusMessageId) return;
      const elapsedSec = Math.round((Date.now() - startTime) / 1000);
      const isConnActive = (Date.now() - lastHeartbeatTime) < 25000;
      const connState = isConnActive ? 'соединение активно' : 'ожидание ответа...';
      const progressText = `⏳ [Накладная ${task.batchIndex} из ${this.batchCounter}] ${actionText}... (${elapsedSec} сек, ${connState})`;
      await this.safeEditMessage(task.chatId, task.statusMessageId, progressText);
    }, this.progressIntervalMs);

    // Phase 1: AI Recognition & Database persistence
    let result: ProcessInvoiceResult;
    try {
      if (isPhoto) {
        result = await this.workflow.processPhotoInvoice({
          photoBuffer: task.photoBuffer!,
          photoFileId: task.photoFileId,
          caption: task.caption,
          userId: task.userId,
          messageId: task.messageId,
          onProgress: (_p: RecognizerProgress) => {
            lastHeartbeatTime = Date.now();
          }
        });
      } else {
        result = await this.workflow.processVoiceInvoice({
          audioBuffer: task.audioBuffer!,
          mimeType: task.audioMimeType,
          userId: task.userId,
          messageId: task.messageId,
          onProgress: (_p: RecognizerProgress) => {
            lastHeartbeatTime = Date.now();
          }
        });
      }
    } catch (recogErr: any) {
      isTaskDone = true;
      clearInterval(progressTimer);
      console.error(`[InvoiceQueue] ❌ Ошибка распознавания накладной #${task.batchIndex}:`, recogErr);

      if (task.statusMessageId) {
        const errorMsg = `❌ <b>Ошибка распознавания:</b> ${escapeHtml(recogErr.message || String(recogErr))}`;
        await this.safeEditMessage(task.chatId, task.statusMessageId, errorMsg);
      } else {
        try {
          await this.api.sendMessage(
            task.chatId,
            `❌ <b>Ошибка распознавания:</b> ${escapeHtml(recogErr.message || String(recogErr))}`,
            { parse_mode: 'HTML' }
          );
        } catch {}
      }

      if (this.onInvoiceError) {
        await this.onInvoiceError(task, recogErr);
      }

      task.reject(recogErr);
      return;
    }

    isTaskDone = true;
    clearInterval(progressTimer);

    if (task.statusMessageId) {
      await this.safeDeleteMessage(task.chatId, task.statusMessageId);
      task.statusMessageId = undefined;
    }

    // Phase 2: Presentation & Telegram delivery (invoice is already saved)
    try {
      if (this.onInvoiceReady) {
        await this.onInvoiceReady(task, result);
      }
      task.resolve(result);
    } catch (deliveryErr: any) {
      console.error(`[InvoiceQueue] ⚠️ Ошибка отправки карточки накладной #${result.invoiceId} в Telegram:`, deliveryErr);

      const warningMsg =
        `⚠️ <b>Накладная #${result.invoiceId} успешно распознана и сохранена</b>, но возникла ошибка при отправке карточки в чат: ${escapeHtml(deliveryErr.message || String(deliveryErr))}\n\n` +
        `Вы можете открыть накладную через команду /invoice_${result.invoiceId} или в Mini App.`;

      try {
        await this.api.sendMessage(task.chatId, warningMsg, { parse_mode: 'HTML' });
      } catch {}

      if (this.onInvoiceError) {
        await this.onInvoiceError(task, deliveryErr);
      }

      task.reject(deliveryErr);
    }
  }

  private async safeEditMessage(chatId: number, messageId: number, text: string): Promise<void> {
    try {
      await this.api.editMessageText(chatId, messageId, text, { parse_mode: 'HTML' });
    } catch (err: any) {
      if (err?.message?.includes('message is not modified')) return;
      console.warn(`[InvoiceQueue] safeEditMessage (${messageId}):`, err?.message || err);
    }
  }

  private async safeDeleteMessage(chatId: number, messageId: number): Promise<void> {
    try {
      await this.api.deleteMessage(chatId, messageId);
    } catch (err: any) {
      console.warn(`[InvoiceQueue] safeDeleteMessage (${messageId}):`, err?.message || err);
    }
  }
}
