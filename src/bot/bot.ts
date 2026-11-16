import { Bot, Context, InlineKeyboard, InputFile } from 'grammy';
import { config } from '../config.js';
import { InvoiceWorkflow } from '../workflow/invoice-workflow.js';
import { formatDailyStats, escapeHtml } from './formatter.js';
import { InvoiceDataSchema, ModelUsageStat } from '../types/index.js';
import { InvoicesRepository } from '../db/invoices.repo.js';
import {
  checkConfiguredModels,
  formatModelReportHtml,
  GeminiAutopilot,
  formatAutopilotReportHtml
} from '../gemini/model-selection.js';
import { InvoiceQueue } from './invoice-queue.js';

export interface EditSession {
  invoiceId: number;
  cardMessageId: number;
  chatId: number;
  editPromptMessageId?: number;
}

export function createInvoiceKeyboard(
  invoiceId: number,
  hasPhoto = true,
  webAppUrl?: string,
  canUndo = false
): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('✅ Создать в iiko', `confirm:${invoiceId}`)
    .text('❌ Отклонить', `reject:${invoiceId}`)
    .row();

  const rawUrl = webAppUrl !== undefined ? webAppUrl : config.webapp.url;
  const isHttps = Boolean(rawUrl && rawUrl.startsWith('https://'));
  if (isHttps) {
    const fullUrl = rawUrl.includes('?') ? `${rawUrl}&invoiceId=${invoiceId}` : `${rawUrl}?invoiceId=${invoiceId}`;
    kb.webApp('📱 Редактор (Mini App)', fullUrl);
  } else {
    kb.text('🎙 Наговорить / Написать правку', `edit:${invoiceId}`);
  }

  kb.text('🔄 Склад', `toggle_wh:${invoiceId}`);
  if (hasPhoto) {
    kb.text('🖼 Фото', `view_photo:${invoiceId}`);
  }

  // Row 3: quick actions (voice/text assistant & undo)
  if (isHttps || canUndo) {
    const row3 = kb.row();
    if (isHttps) {
      row3.text('🎙 Наговорить / Написать правку', `edit:${invoiceId}`);
    }
    if (canUndo) {
      row3.text('↩️ Отменить правку', `undo:${invoiceId}`);
    }
  }

  return kb;
}

export function createEditKeyboard(invoiceId: number, canUndo = false, webAppUrl?: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  const rawUrl = webAppUrl !== undefined ? webAppUrl : config.webapp.url;
  if (rawUrl && rawUrl.startsWith('https://')) {
    const fullUrl = rawUrl.includes('?') ? `${rawUrl}&invoiceId=${invoiceId}` : `${rawUrl}?invoiceId=${invoiceId}`;
    kb.webApp('📱 Открыть в Mini App', fullUrl).row();
  }
  if (canUndo) {
    kb.text('↩️ Отменить правку', `undo:${invoiceId}`).row();
  }
  kb.text('🗑 Удалить строку...', `del_picker:${invoiceId}`)
    .text('🔙 Завершить', `finish_edit:${invoiceId}`);
  return kb;
}

export async function updateTelegramInvoiceCard(
  bot: Bot,
  workflow: InvoiceWorkflow,
  invoiceId: number,
  cardText?: string,
  hasPhoto?: boolean
): Promise<boolean> {
  const card = workflow.getInvoiceCard(invoiceId);
  if (!card) return false;

  const chatId = card.domain.invoice.telegram_chat_id;
  const messageId = card.domain.invoice.card_message_id;
  const text = cardText || card.cardText;
  const photo = hasPhoto !== undefined ? hasPhoto : card.hasPhoto;
  const canUndo = workflow.canUndo(invoiceId);

  if (chatId && messageId) {
    try {
      await bot.api.editMessageText(chatId, messageId, text, {
        parse_mode: 'HTML',
        reply_markup: createInvoiceKeyboard(invoiceId, photo, undefined, canUndo)
      });
      return true;
    } catch (err) {
      console.warn(`[Bot] Не удалось обновить сообщение ${messageId} в чате ${chatId}:`, err);
    }
  }
  return false;
}

async function safeReact(ctx: Context, emoji: string): Promise<void> {
  try {
    await ctx.react(emoji as any);
  } catch {
    // Silently ignore if reactions are disabled in chat
  }
}

async function safeBotReact(bot: Bot, chatId: number, messageId: number, emoji: string): Promise<void> {
  try {
    await bot.api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: emoji as any }]);
  } catch {
    // Silently ignore if reactions are disabled in chat
  }
}

async function safeAction(
  ctx: Context,
  action: 'typing' | 'upload_photo' | 'record_voice' | 'choose_sticker'
): Promise<void> {
  try {
    await ctx.replyWithChatAction(action);
  } catch {
    // Silently ignore
  }
}

// --- Callback action handlers ---

async function handleToggleWh(ctx: Context, workflow: InvoiceWorkflow, invoiceId: number): Promise<void> {
  const res = workflow.toggleWarehouse(invoiceId);
  if (!res.success || !res.cardText) {
    await ctx.answerCallbackQuery({ text: res.error || 'Ошибка смены склада' });
    return;
  }

  const keyboard = createInvoiceKeyboard(invoiceId, !!res.hasPhoto, undefined, workflow.canUndo(invoiceId));
  try {
    await ctx.editMessageText(res.cardText, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  } catch {
    // Message text unchanged
  }
  const whName = res.newWarehouse === 'household' ? 'Хоз склад' : 'Склад Кухня';
  await ctx.answerCallbackQuery({ text: `Склад изменен на: ${whName}` });
}

async function handleViewPhoto(ctx: Context, workflow: InvoiceWorkflow, invoiceId: number): Promise<void> {
  const localPath = workflow.getPhotoPath(invoiceId);
  if (localPath) {
    await ctx.replyWithPhoto(new InputFile(localPath), {
      caption: `🖼 <b>Оригинал фото к накладной #${invoiceId}</b>`,
      parse_mode: 'HTML'
    });
    await ctx.answerCallbackQuery();
    return;
  }

  const card = workflow.getInvoiceCard(invoiceId);
  if (card?.domain.invoice.photo_file_id) {
    await ctx.replyWithPhoto(card.domain.invoice.photo_file_id, {
      caption: `🖼 <b>Оригинал фото к накладной #${invoiceId}</b>`,
      parse_mode: 'HTML'
    });
    await ctx.answerCallbackQuery();
    return;
  }

  await ctx.answerCallbackQuery({ text: 'Фото для этой накладной не найдено' });
}

async function handleConfirm(
  ctx: Context,
  workflow: InvoiceWorkflow,
  invoiceId: number
): Promise<void> {
  const userId = ctx.from?.id || 0;
  workflow.deleteEditSession(userId);

  const card = workflow.getInvoiceCard(invoiceId);
  if (!card) {
    await ctx.answerCallbackQuery({ text: 'Накладная не найдена' });
    return;
  }

  if (card.domain.invoice.status === 'synced') {
    await ctx.answerCallbackQuery({ text: 'Накладная уже была создана в iiko!' });
    return;
  }

  if (workflow.isSyncInProgress(invoiceId)) {
    await ctx.answerCallbackQuery({
      text: '⏳ Накладная уже отправляется в iikoWeb, пожалуйста, подождите...',
      show_alert: true
    });
    return;
  }

  await ctx.answerCallbackQuery({ text: 'Отправляю в iiko...' });

  const inProgressKeyboard = new InlineKeyboard().text(
    '⏳ Создаю документ в iikoWeb...',
    `busy:${invoiceId}`
  );
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: inProgressKeyboard });
  } catch {}

  const result = await workflow.confirmAndSync(invoiceId);
  if (result.success) {
    await safeReact(ctx, '✅');
    const baseText = card.cardText;
    const modeNotice = result.isMock ? ' <i>(демо-режим)</i>' : '';
    const unmatchedNotice = result.unmatched?.length
      ? `\n⚠️ <b>Не найдены в iiko и не добавлены:</b> ${escapeHtml(result.unmatched.join(', '))}`
      : '';
    const unitNotice = result.unitWarnings?.length
      ? `\n` + result.unitWarnings.map(w => `⚠️ ${escapeHtml(w)}`).join('\n')
      : '';
    const docInfo = result.documentNumbers?.kitchen && result.documentNumbers?.household
      ? `Номера накладных (раздельно по складам):\n• 🍽 Склад Кухня: <code>${escapeHtml(result.documentNumbers.kitchen)}</code>\n• 🏠 Хоз склад: <code>${escapeHtml(result.documentNumbers.household)}</code>`
      : `Номер накладной: <code>${escapeHtml(result.documentNumber || '')}</code>`;

    const updatedText = `${baseText}\n\n✅ <b>Создано в iiko!</b>\n${docInfo}${modeNotice}${unmatchedNotice}${unitNotice}\n<i>Зайдите в iikoWeb и проведите документы.</i>`;

    try {
      await ctx.editMessageText(updatedText, {
        parse_mode: 'HTML',
        reply_markup: undefined
      });
    } catch {
      await ctx.reply(`✅ <b>Накладная #${invoiceId} создана в iiko!</b>\n${docInfo}`, {
        parse_mode: 'HTML'
      });
    }
  } else if (result.alreadySynced) {
    // Already synced: remove buttons and notify user
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } catch {}
    await ctx.reply(
      `⚠️ <b>Накладная уже была создана в iiko!</b>\n${escapeHtml(result.message || '')}`,
      { parse_mode: 'HTML' }
    );
  } else if (result.isSplit && result.documentNumber) {
    // Partial split sync: kitchen succeeded, household failed.
    // Database is already in 'synced' state to avoid kitchen duplicates on retry.
    // Remove buttons to prevent re-sending kitchen
    await safeReact(ctx, '⚠️');
    const baseText = card.cardText;
    const partialCardText = `${baseText}\n\n⚠️ <b>Частично создано в iiko!</b>\n• 🍽 Склад Кухня: <code>${escapeHtml(result.documentNumber)}</code>\n• 🏠 Хоз склад: <i>Ошибка отправки</i>\n\n<i>Накладная кухни создана в iikoWeb. Хоз склад не был добавлен во избежание дублирования.</i>`;
    try {
      await ctx.editMessageText(partialCardText, {
        parse_mode: 'HTML',
        reply_markup: undefined
      });
    } catch {}

    await ctx.reply(
      `⚠️ <b>Частичное создание в iiko:</b>\n\n${escapeHtml(result.message || '')}\n\n<i>Накладная «Кухня» уже создана в iikoWeb (#${escapeHtml(result.documentNumber)}). Неотправленные позиции хоз склада можно провести вручную в iikoWeb или прислать отдельным сообщением.</i>`,
      { parse_mode: 'HTML' }
    );
  } else {
    // Retryable pre-sync error (unmatched nomenclature, iiko 500, network error): restore buttons so the user can review or retry
    const restoredCard = workflow.getInvoiceCard(invoiceId);
    const restoredKeyboard = createInvoiceKeyboard(
      invoiceId,
      restoredCard ? Boolean(restoredCard.domain.invoice.photo_file_id || restoredCard.domain.invoice.local_photo_path || workflow.getPhotoPath(invoiceId)) : true,
      undefined,
      workflow.canUndo(invoiceId)
    );
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: restoredKeyboard });
    } catch {}

    if (result.unmatched && result.unmatched.length > 0) {
      await safeReact(ctx, '⚠️');
      await ctx.reply(
        `⚠️ <b>Создание в iiko заблокировано:</b>\n\n${escapeHtml(result.message || 'Обнаружены несопоставленные позиции')}\n\n<i>Откройте [📱 Редактор (Mini App)], выберите товары из номенклатуры и нажмите «Создать в iiko».</i>`,
        { parse_mode: 'HTML' }
      );
    } else {
      await safeReact(ctx, '⚠️');
      await ctx.reply(`⚠️ <b>Ошибка iiko:</b> ${escapeHtml(result.message || 'Неизвестная ошибка')}`, {
        parse_mode: 'HTML'
      });
    }
  }
}

async function handleReject(
  ctx: Context,
  workflow: InvoiceWorkflow,
  invoiceId: number
): Promise<void> {
  const card = workflow.getInvoiceCard(invoiceId);
  if (card && card.domain.invoice.status === 'synced') {
    await ctx.answerCallbackQuery({ text: 'Накладная уже была создана в iiko и не может быть отклонена!' });
    return;
  }

  const rejectRes = workflow.rejectInvoice(invoiceId);
  if (!rejectRes.success) {
    await ctx.answerCallbackQuery({ text: rejectRes.error || 'Ошибка отклонения накладной' });
    return;
  }

  const userId = ctx.from?.id || 0;
  workflow.deleteEditSession(userId);
  await safeReact(ctx, '🗑');
  await ctx.answerCallbackQuery({ text: 'Накладная отклонена' });

  const baseText = card ? card.cardText : (ctx.callbackQuery?.message?.text ? escapeHtml(ctx.callbackQuery.message.text) : '');
  try {
    await ctx.editMessageText(`${baseText}\n\n❌ <b>Накладная отклонена.</b>`, {
      parse_mode: 'HTML',
      reply_markup: undefined
    });
  } catch {
    await ctx.reply(`❌ <b>Накладная #${invoiceId} отклонена.</b>`, { parse_mode: 'HTML' });
  }
}

async function handleUndo(
  ctx: Context,
  workflow: InvoiceWorkflow,
  invoiceId: number,
  bot: Bot
): Promise<void> {
  const res = workflow.undoEdit(invoiceId);
  if (!res.success || !res.cardText) {
    await ctx.answerCallbackQuery({ text: res.message || 'Нет сохраненных правок для отмены' });
    return;
  }

  await safeReact(ctx, '↩️');

  // Update the real card using updateTelegramInvoiceCard with stored card_message_id
  await updateTelegramInvoiceCard(bot, workflow, invoiceId, res.cardText, !!res.hasPhoto);

  // If callback was clicked from an edit prompt (not the card itself), update the prompt message without replacing it with card
  const card = workflow.getInvoiceCard(invoiceId);
  const cardMsgId = card?.domain.invoice.card_message_id;
  const clickedMsgId = ctx.callbackQuery?.message?.message_id;

  if (clickedMsgId && cardMsgId && clickedMsgId !== cardMsgId && res.editableText) {
    try {
      await ctx.editMessageText(
        `↩️ <b>Правка отменена!</b> Карточка накладной #${invoiceId} возвращена к предыдущему состоянию.\n\n` +
        `Текущий состав:\n<pre><code>${escapeHtml(res.editableText)}</code></pre>`,
        {
          parse_mode: 'HTML',
          reply_markup: createEditKeyboard(invoiceId, workflow.canUndo(invoiceId))
        }
      );
    } catch {}
  }

  await ctx.answerCallbackQuery({ text: 'Предыдущая правка отменена!' });
}

async function handleEditStart(
  ctx: Context,
  workflow: InvoiceWorkflow,
  invoiceId: number
): Promise<void> {
  const card = workflow.getInvoiceCard(invoiceId);
  if (!card) {
    await ctx.answerCallbackQuery({ text: 'Накладная не найдена' });
    return;
  }

  const promptMsg = await ctx.reply(
    `✏️ <b>Редактирование накладной #${invoiceId}</b>\n\n` +
    `🎙 <b>Наговорите голосом</b> или <b>напишите свободным текстом:</b>\n` +
    `• «Помидоры не по 200, а по 180»\n` +
    `• «Поставщик ИП Ахмедов»\n` +
    `• «Удали вторую строку и добавь перчатки 2 пачки по 150»\n\n` +
    `<i>Либо точечной командой:</i>\n` +
    `• <code>1: 15 * 600</code> — кол-во * цена\n` +
    `• <code>1 15 600</code> — короткий формат (строка кол-во цена)\n` +
    `• <code>1 склад хоз</code> — перевести строку на Хоз склад\n` +
    `• <code>удалить 2</code> — удалить строку 2\n` +
    `• <code>+ Салфетки 5 * 60</code> — добавить позицию\n` +
    `• <code>поставщик: Название</code> — сменить поставщика\n\n` +
    `📋 <i>Кликните/тапните по тексту ниже, чтобы скопировать и отредактировать:</i>\n\n` +
    `<pre><code>${escapeHtml(card.editableText)}</code></pre>`,
    {
      parse_mode: 'HTML',
      reply_markup: createEditKeyboard(invoiceId, workflow.canUndo(invoiceId))
    }
  );

  const session: EditSession = {
    invoiceId,
    cardMessageId: ctx.callbackQuery?.message?.message_id || 0,
    chatId: ctx.chat?.id || 0,
    editPromptMessageId: promptMsg.message_id
  };

  const userId = ctx.from?.id || 0;
  workflow.saveEditSession(userId, session);

  await safeReact(ctx, '✍️');
  await ctx.answerCallbackQuery({ text: 'Режим редактирования открыт' });
}

async function handleDeletePicker(ctx: Context, workflow: InvoiceWorkflow, invoiceId: number): Promise<void> {
  const card = workflow.getInvoiceCard(invoiceId);
  if (!card || card.domain.data.items.length === 0) {
    await ctx.answerCallbackQuery({ text: 'В накладной нет строк для удаления' });
    return;
  }

  const kb = new InlineKeyboard();
  card.domain.data.items.forEach((item, idx) => {
    kb.text(`🗑 #${idx + 1} ${item.name.slice(0, 16)} (${item.qty} * ${item.price})`, `del_item:${invoiceId}:${idx}`).row();
  });
  kb.text('🔙 Назад', `edit_refresh:${invoiceId}`);

  try {
    await ctx.editMessageText('🗑 <b>Выберите позицию для удаления:</b>', {
      parse_mode: 'HTML',
      reply_markup: kb
    });
  } catch {}
  await ctx.answerCallbackQuery();
}

async function handleDeleteItem(
  ctx: Context,
  workflow: InvoiceWorkflow,
  invoiceId: number,
  itemIdx: number,
  bot?: Bot
): Promise<void> {
  const res = workflow.deleteItem(invoiceId, itemIdx);
  if (!res.success || !res.removedItem || !res.editableText) {
    await ctx.answerCallbackQuery({ text: res.error || 'Ошибка удаления позиции' });
    return;
  }

  // Update main card message in-place
  if (bot) {
    await updateTelegramInvoiceCard(bot, workflow, invoiceId, res.cardText, !!res.hasPhoto);
  } else {
    const userId = ctx.from?.id || 0;
    const session = workflow.getEditSession(userId);
    if (session?.cardMessageId && session?.chatId && res.cardText) {
      try {
        await ctx.api.editMessageText(session.chatId, session.cardMessageId, res.cardText, {
          parse_mode: 'HTML',
          reply_markup: createInvoiceKeyboard(invoiceId, !!res.hasPhoto, undefined, workflow.canUndo(invoiceId))
        });
      } catch {}
    }
  }

  try {
    await ctx.editMessageText(
      `🗑 Позиция <b>«${escapeHtml(res.removedItem.name)}»</b> удалена.\n\n` +
      `Текущий состав накладной:\n<pre><code>${escapeHtml(res.editableText)}</code></pre>`,
      {
        parse_mode: 'HTML',
        reply_markup: createEditKeyboard(invoiceId, workflow.canUndo(invoiceId))
      }
    );
  } catch {}
  await ctx.answerCallbackQuery({ text: `Удалено: ${res.removedItem.name}` });
}

async function handleEditRefresh(ctx: Context, workflow: InvoiceWorkflow, invoiceId: number): Promise<void> {
  const card = workflow.getInvoiceCard(invoiceId);
  if (!card) {
    await ctx.answerCallbackQuery({ text: 'Накладная не найдена' });
    return;
  }

  try {
    await ctx.editMessageText(
      `✏️ <b>Редактирование накладной #${invoiceId}</b>\n\n` +
      `🎙 <b>Наговорите голосом</b> или <b>напишите свободным текстом</b> (например: «Помидоры не по 200, а по 180»).\n\n` +
      `<i>Либо отправьте точечную команду:</i>\n` +
      `• <code>1: 15 * 600</code> — изменить строку 1 (кол-во * цена)\n` +
      `• <code>1 15 600</code> — короткий формат (строка кол-во цена)\n` +
      `• <code>1 склад хоз</code> — перевести строку на Хоз склад\n` +
      `• <code>удалить 2</code> — удалить строку 2\n` +
      `• <code>+ Салфетки 5 * 60</code> — добавить позицию\n` +
      `• <code>поставщик: Название</code> — сменить поставщика\n\n` +
      `📋 <i>Кликните/тапните по тексту ниже, чтобы скопировать:</i>\n\n` +
      `<pre><code>${escapeHtml(card.editableText)}</code></pre>`,
      {
        parse_mode: 'HTML',
        reply_markup: createEditKeyboard(invoiceId, workflow.canUndo(invoiceId))
      }
    );
  } catch {}
  await ctx.answerCallbackQuery();
}

async function handleFinishEdit(ctx: Context, workflow: InvoiceWorkflow): Promise<void> {
  const userId = ctx.from?.id || 0;
  workflow.deleteEditSession(userId);
  try {
    await ctx.editMessageText(
      `✅ <b>Редактирование завершено.</b> Карточка накладной обновлена выше и готова к созданию в iiko.`,
      { parse_mode: 'HTML' }
    );
  } catch {}
  await ctx.answerCallbackQuery({ text: 'Готово!' });
}

export function formatModelsOverview(stats: ModelUsageStat[]): string {
  const lines: string[] = [
    '🤖 <b>Настройка моделей Gemini ресторана «Бейни»</b>',
    '',
    '🎯 <b>Подбор моделей по типам задач:</b>',
    `• 📸 <b>Фото накладных (чеки):</b>\n  <code>${config.gemini.photoModels.map(escapeHtml).join(', ')}</code>`,
    `• 🎙 <b>Голосовые заказы (аудио):</b>\n  <code>${config.gemini.voiceModels.map(escapeHtml).join(', ')}</code>`,
    `• ⚡️ <b>Сложные чеки (каскадная эскалация):</b>\n  <code>${config.gemini.complexModels.map(escapeHtml).join(', ')}</code>`,
    ''
  ];

  if (stats.length > 0) {
    lines.push('📊 <b>Статистика распознаваний из базы:</b>');
    for (const s of stats) {
      lines.push(`• <code>${escapeHtml(s.model)}</code>: <b>${s.count}</b> накладных`);
    }
    lines.push('');
  } else {
    lines.push('📊 <i>Статистика: накладных с фиксацией модели пока нет в базе.</i>\n');
  }

  lines.push('💡 <i>Вы можете проверить онлайн-статус и отклик моделей прямо сейчас:</i>');
  return lines.join('\n');
}

async function handleCheckModelsCallback(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery({ text: 'Автопилот проверяет модели в Google API...' });
  try {
    try {
      await ctx.editMessageText('🚀 <b>Автопилот выполняет бенчмарк моделей в Google API...</b>\n<i>Замеряю задержку и проверяю reasoning...</i>', {
        parse_mode: 'HTML'
      });
    } catch {
      // ignore placeholder edit failure
    }

    const autopilot = GeminiAutopilot.getInstance();
    const plan = await autopilot.refresh(true);
    const text = formatAutopilotReportHtml(plan);
    const kb = new InlineKeyboard()
      .text('🔄 Обновить автопилот', 'check_models')
      .text('📋 К статистике', 'models_overview');

    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: kb
    });
  } catch (err: any) {
    if (err.message?.includes('message is not modified')) {
      return;
    }
    const retryKb = new InlineKeyboard()
      .text('🔄 Повторить попытку', 'check_models')
      .text('📋 К статистике', 'models_overview');
    try {
      await ctx.editMessageText(`❌ <b>Ошибка проверки моделей:</b> ${escapeHtml(err.message || String(err))}`, {
        parse_mode: 'HTML',
        reply_markup: retryKb
      });
    } catch {
      await ctx.reply(`❌ <b>Ошибка проверки моделей:</b> ${escapeHtml(err.message || String(err))}`, {
        parse_mode: 'HTML',
        reply_markup: retryKb
      });
    }
  }
}

async function handleModelsOverviewCallback(ctx: Context, repo: InvoicesRepository): Promise<void> {
  await ctx.answerCallbackQuery();
  const stats = repo.getModelStats();
  const text = formatModelsOverview(stats);
  const kb = new InlineKeyboard().text('🚀 Статус автопилота', 'check_models');
  try {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: kb
    });
  } catch (err: any) {
    if (!err.message?.includes('message is not modified')) {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }
  }
}

// --- Main bot factory ---

export function createBot(workflowInstance?: InvoiceWorkflow): Bot {
  if (!config.telegram.token) {
    throw new Error('TELEGRAM_TOKEN не найден в .env');
  }

  const bot = new Bot(config.telegram.token);
  const workflow = workflowInstance || new InvoiceWorkflow();
  const repo = workflow.getRepo();

  const invoiceQueue = new InvoiceQueue({
    workflow,
    api: bot.api,
    interTaskDelayMs: 2500,
    progressIntervalMs: 4000,
    onInvoiceReady: async (task, result) => {
      const keyboard = createInvoiceKeyboard(
        result.invoiceId,
        result.hasPhoto,
        undefined,
        workflow.canUndo(result.invoiceId)
      );
      const userId = task.userId || 0;
      workflow.deleteEditSession(userId);

      await safeBotReact(bot, task.chatId, task.messageId, '⚡');
      const sentMsg = await bot.api.sendMessage(task.chatId, result.cardText, {
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
      workflow.updateInvoiceTelegramMessage(result.invoiceId, task.chatId, sentMsg.message_id);
    }
  });

  // Access control middleware
  bot.use(async (ctx, next) => {
    if (ctx.message?.text === '/id' || ctx.message?.text === '/myid') {
      await ctx.reply(
        `🆔 <b>Ваш Telegram ID:</b> <code>${ctx.from?.id}</code>\n\n` +
        `Скопируйте его и добавьте в файл <code>.env</code>:\n` +
        `<code>ALLOWED_USER_IDS=${ctx.from?.id}</code>\n\n` +
        `После этого бот станет на 100% приватным и будет отвечать только вам.`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const allowed = config.telegram.allowedUserIds;
    if (allowed.length > 0 && ctx.from && !allowed.includes(ctx.from.id)) {
      await ctx.reply(`⛔ <b>Доступ ограничен.</b> Этот бот работает в приватном режиме ресторана «Бейни».\n\nВаш ID: <code>${ctx.from.id}</code>`, { parse_mode: 'HTML' });
      return;
    }
    await next();
  });

  // /start command
  bot.command('start', async (ctx) => {
    const isRestricted = config.telegram.allowedUserIds.length > 0;
    const privacyNotice = isRestricted
      ? `🔒 <i>Режим доступа: приватный (только для авторизованных пользователей)</i>`
      : `⚠️ <i>Внимание: белый список пока пуст. Отправьте команду /id, чтобы узнать свой ID и закрыть доступ посторонним.</i>`;

    await ctx.reply(
      '👋 <b>Привет!</b>\n\n' +
      'Я бот ресторана <b>Бейни</b> для распознавания рукописных накладных с интеграцией в iiko.\n\n' +
      `${privacyNotice}\n\n` +
      `🆔 <b>Ваш ID:</b> <code>${ctx.from?.id}</code>\n\n` +
      '📸 <b>Как пользоваться:</b>\n' +
      '1. Отправь фото накладной или голосовое сообщение с продиктованным заказом.\n' +
      '2. Нейросеть распознает наименования, цены, количества и склад.\n' +
      '3. Бот сверит цены с предыдущими закупками из базы данных и предупредит о подорожании или дубликатах.\n' +
      '4. Нажми кнопку <b>[✅ Создать в iiko]</b> для проведения документа.\n\n' +
      '<b>Команды:</b>\n' +
      '/today — сводка расходов за сегодня\n' +
      '/history — последние 10 накладных\n' +
      '/export — выгрузить CSV файл для бухгалтера\n' +
      '/models — статус и проверка моделей Gemini\n' +
      '/app — Telegram Mini App редактор накладных\n' +
      '/help — справка по возможностям',
      { parse_mode: 'HTML' }
    );
  });

  // /help command
  bot.command('help', async (ctx) => {
    await ctx.reply(
      'ℹ️ <b>Справка по возможностям:</b>\n\n' +
      '• <b>Фото накладных:</b> отправляйте по одной или пачкой — каждая накладная обрабатывается отдельно.\n' +
      '• <b>Голосовые сообщения:</b> можно надиктовать голосом («Бойня, 10 кг говядины по 600 рублей на кухню»).\n' +
      '• <b>Подбор моделей:</b> команда /models отображает используемые модели под фото/голос/эскалацию и их отклик.\n' +
      '• <b>Mini App (WebApp):</b> удобный сенсорный редактор с пересчетом сумм и кнопочными степперами.\n' +
      '• <b>Смена склада:</b> кнопка <i>[🔄 Склад]</i> в один клик переключает Кухня ⇄ Хоз склад.\n' +
      '• <b>Сверка цен:</b> предупреждения о росте цен по сравнению с прошлыми поставками.\n' +
      '• <b>Архив фото:</b> кнопка <i>[🖼 Фото]</i> позволяет в любой момент посмотреть оригинал чека.',
      { parse_mode: 'HTML' }
    );
  });

  // /models command
  bot.command('models', async (ctx) => {
    const autopilot = GeminiAutopilot.getInstance();
    const plan = autopilot.getPlan();
    const text = formatAutopilotReportHtml(plan);
    const kb = new InlineKeyboard()
      .text('🔄 Обновить автопилот', 'check_models')
      .text('📋 Статистика накладных', 'models_overview');
    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: kb
    });
  });

  // /app or /webapp command
  bot.command(['app', 'webapp'], async (ctx) => {
    const webappUrl = config.webapp.url;
    if (webappUrl && webappUrl.startsWith('https://')) {
      const kb = new InlineKeyboard().webApp('📱 Открыть редактор накладных', webappUrl);
      await ctx.reply(
        '📱 <b>Telegram Mini App (WebApp)</b>\n\n' +
        'Сенсорный редактор накладных ресторана «Бейни»:\n' +
        '• Быстрое изменение количеств (+ / −)\n' +
        '• Правка цен и автоматический пересчет сумм\n' +
        '• Смена склада (Кухня 🍽 ⇄ Хоз склад 🏠)\n' +
        '• Добавление и удаление позиций\n' +
        '• Сопоставление с номенклатурой iiko\n\n' +
        '<i>Нажмите кнопку ниже, чтобы открыть приложение:</i>',
        {
          parse_mode: 'HTML',
          reply_markup: kb
        }
      );
    } else {
      const localPort = config.webapp.port;
      await ctx.reply(
        'ℹ️ <b>Telegram Mini App редактор</b>\n\n' +
        `Локальный веб-сервер Mini App активен на порту <code>${localPort}</code>.\n\n` +
        '<b>Почему кнопка недоступна внутри Telegram?</b>\n' +
        'Telegram требует обязательный публичный <b>HTTPS-адрес</b> (политика безопасности Telegram запрещает открытие <code>http://localhost</code> внутри мессенджера).\n\n' +
        '<b>Как подключить за 1 минуту:</b>\n' +
        '1️⃣ <b>В облаке (Amvera):</b> укажите в переменных окружения:\n' +
        '<code>WEBAPP_URL=https://&lt;домен-amvera&gt;</code>\n\n' +
        '2️⃣ <b>При локальном запуске (на ПК):</b> запустите бесплатный туннель:\n' +
        `<code>npx localtunnel --port ${localPort}</code>\n` +
        'и скопируйте полученную ссылку в <code>.env</code> в переменную <code>WEBAPP_URL</code>.\n\n' +
        `<i>Для проверки прямо сейчас в браузере на этом ПК: <a href="http://localhost:${localPort}/webapp">http://localhost:${localPort}/webapp</a></i>`,
        { parse_mode: 'HTML' }
      );
    }
  });

  // /today command
  bot.command('today', async (ctx) => {
    const stats = repo.getDailyStats();
    await ctx.reply(formatDailyStats(stats), { parse_mode: 'HTML' });
  });

  // /history command
  bot.command('history', async (ctx) => {
    const recent = repo.getRecentInvoices(10);
    if (recent.length === 0) {
      await ctx.reply('📭 В базе пока нет сохраненных накладных.');
      return;
    }

    const lines = ['📜 <b>История последних накладных:</b>', ''];
    for (const inv of recent) {
      let statusIcon = '⏳';
      if (inv.status === 'synced') statusIcon = '✅';
      else if (inv.status === 'rejected') statusIcon = '❌';

      const docInfo = inv.iiko_document_id ? ` (iiko #${escapeHtml(inv.iiko_document_id)})` : '';
      lines.push(
        `${statusIcon} <b>#${inv.id}</b> | ${escapeHtml(inv.date)} | <b>${escapeHtml(inv.supplier)}</b> | ${Math.round(inv.total_calculated)} ₽${docInfo}`
      );
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  // /export command
  bot.command('export', async (ctx) => {
    const csvContent = repo.exportCsv(200);
    const bom = '\uFEFF';
    const buffer = Buffer.from(bom + csvContent, 'utf-8');
    const today = new Date().toISOString().slice(0, 10);

    await ctx.replyWithDocument(new InputFile(buffer, `invoices_${today}.csv`), {
      caption: `📁 <b>Выгрузка накладных для Excel/1C</b> (до 200 записей).`,
      parse_mode: 'HTML'
    });
  });

  // Photo handler with sequential queue
  bot.on('message:photo', async (ctx) => {
    await safeReact(ctx, '👀');
    await safeAction(ctx, 'upload_photo');

    try {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const file = await ctx.api.getFile(photo.file_id);
      if (!file.file_path) {
        throw new Error('Не удалось получить путь к файлу в Telegram.');
      }

      const fileUrl = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
      const imgRes = await fetch(fileUrl);
      if (!imgRes.ok) {
        throw new Error(`Ошибка загрузки фото из Telegram: ${imgRes.status}`);
      }

      const arrayBuf = await imgRes.arrayBuffer();
      const photoBuffer = Buffer.from(arrayBuf);
      console.log(`[Photo] Получено фото от @${ctx.from?.username || ctx.from?.id}: ${photo.file_id}, размер: ${(photoBuffer.length / 1024).toFixed(1)} КБ`);

      await invoiceQueue.enqueuePhoto({
        chatId: ctx.chat.id,
        userId: ctx.from?.id,
        messageId: ctx.message.message_id,
        photoBuffer,
        photoFileId: photo.file_id,
        caption: ctx.message.caption?.trim()
      }).catch((queueErr) => {
        // Ошибка распознавания уже выведена пользователю через статусное сообщение очереди
        console.warn(`[Photo] Ошибка распознавания накладной #${photo.file_id}:`, queueErr?.message || queueErr);
      });
    } catch (err: any) {
      console.error('Ошибка добавления фото в очередь:', err);
      await ctx.reply(`❌ <b>Ошибка:</b> ${escapeHtml(err.message || String(err))}`, { parse_mode: 'HTML' });
    }
  });

  // Voice handler
  bot.on('message:voice', async (ctx) => {
    const userId = ctx.from?.id || 0;
    const session = workflow.getEditSession(userId);
    let editInvoiceId: number | null = session ? session.invoiceId : null;
    let cardMessageId: number | null = session ? session.cardMessageId : null;
    let chatId: number = session ? session.chatId : (ctx.chat?.id || 0);

    if (!editInvoiceId && ctx.message.reply_to_message) {
      const replyText = ctx.message.reply_to_message.text || ctx.message.reply_to_message.caption || '';
      const match = replyText.match(/Накладная #(\d+)/i) || replyText.match(/накладной #(\d+)/i);
      if (match) {
        editInvoiceId = parseInt(match[1], 10);
        const card = workflow.getInvoiceCard(editInvoiceId);
        cardMessageId = card?.domain.invoice.card_message_id || ctx.message.reply_to_message.message_id;
        chatId = card?.domain.invoice.telegram_chat_id || ctx.chat?.id || 0;
      }
    }

    if (editInvoiceId) {
      await safeReact(ctx, '👂');
      await safeAction(ctx, 'record_voice');

      const statusMsg = await ctx.reply('🎙 <i>Слушаю голосовую правку через нейросеть...</i>', {
        parse_mode: 'HTML'
      });

      try {
        const voice = ctx.message.voice;
        const file = await ctx.api.getFile(voice.file_id);
        if (!file.file_path) {
          throw new Error('Не удалось получить путь к аудио в Telegram.');
        }

        const fileUrl = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
        const audioRes = await fetch(fileUrl);
        if (!audioRes.ok) {
          throw new Error(`Ошибка загрузки аудио: ${audioRes.status}`);
        }

        const audioBuf = Buffer.from(await audioRes.arrayBuffer());
        const res = await workflow.applyVoiceEdit(editInvoiceId, audioBuf, 'audio/ogg');

        await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);

        if (!res.success || !res.editableText) {
          await ctx.reply(
            `⚠️ <b>Не удалось применить голосовую правку:</b>\n\n${escapeHtml(res.message)}\n\n` +
            `<i>Попробуйте наговорить ещё раз или отправьте текстовую команду (например: <code>1: 15 * 600</code>).</i>`,
            {
              parse_mode: 'HTML',
              reply_markup: createEditKeyboard(editInvoiceId, workflow.canUndo(editInvoiceId))
            }
          );
          return;
        }

        // Update real card using domain.invoice.card_message_id
        await updateTelegramInvoiceCard(bot, workflow, editInvoiceId, res.cardText, !!res.hasPhoto);

        await safeReact(ctx, '⚡');
        await ctx.reply(
          `✅ ${escapeHtml(res.message)}\n\n` +
          `⬆️ <b>Карточка накладной #${editInvoiceId} выше обновлена!</b>\n\n` +
          `Текущий состав:\n<pre><code>${escapeHtml(res.editableText)}</code></pre>`,
          {
            parse_mode: 'HTML',
            reply_markup: createEditKeyboard(editInvoiceId, workflow.canUndo(editInvoiceId))
          }
        );
        return;
      } catch (err: any) {
        console.error('Ошибка применения голосовой правки:', err);
        try {
          await ctx.api.editMessageText(
            ctx.chat.id,
            statusMsg.message_id,
            `❌ <b>Ошибка:</b> ${escapeHtml(err.message || String(err))}`,
            { parse_mode: 'HTML' }
          );
        } catch {
          await ctx.reply(`❌ <b>Ошибка:</b> ${escapeHtml(err.message || String(err))}`, { parse_mode: 'HTML' });
        }
        return;
      }
    }

    // New invoice voice recognition with queue
    await safeReact(ctx, '👂');
    await safeAction(ctx, 'record_voice');

    try {
      const voice = ctx.message.voice;
      const file = await ctx.api.getFile(voice.file_id);
      if (!file.file_path) {
        throw new Error('Не удалось получить путь к аудио в Telegram.');
      }

      const fileUrl = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
      const audioRes = await fetch(fileUrl);
      if (!audioRes.ok) {
        throw new Error(`Ошибка загрузки аудио: ${audioRes.status}`);
      }

      const audioBuf = Buffer.from(await audioRes.arrayBuffer());

      await invoiceQueue.enqueueVoice({
        chatId: ctx.chat.id,
        userId: ctx.from?.id,
        messageId: ctx.message.message_id,
        audioBuffer: audioBuf,
        audioMimeType: 'audio/ogg'
      }).catch((queueErr) => {
        // Ошибка распознавания уже выведена пользователю через статусное сообщение очереди
        console.warn('[Voice] Ошибка распознавания голоса из очереди:', queueErr?.message || queueErr);
      });
    } catch (err: any) {
      console.error('Ошибка постановки голоса в очередь:', err);
      await ctx.reply(`❌ <b>Ошибка:</b> ${escapeHtml(err.message || String(err))}`, { parse_mode: 'HTML' });
    }
  });

  const inFlightCallbacks = new Set<string>();

  // Callback query dispatcher
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (data === 'check_models') {
      return handleCheckModelsCallback(ctx);
    }
    if (data === 'models_overview') {
      return handleModelsOverviewCallback(ctx, repo);
    }

    const [action, idStr, extra] = data.split(':');
    const invoiceId = parseInt(idStr, 10);

    if (action === 'busy') {
      await ctx.answerCallbackQuery({
        text: '⏳ Накладная отправляется в iikoWeb, пожалуйста, подождите...',
        show_alert: false
      });
      return;
    }

    if (isNaN(invoiceId)) {
      await ctx.answerCallbackQuery({ text: 'Некорректный ID накладной' });
      return;
    }

    const callbackLockKey = `${invoiceId}:${action}`;
    if (inFlightCallbacks.has(callbackLockKey) || (action === 'confirm' && workflow.isSyncInProgress(invoiceId))) {
      await ctx.answerCallbackQuery({
        text: '⏳ Запрос уже обрабатывается, пожалуйста, подождите...',
        show_alert: false
      });
      return;
    }

    inFlightCallbacks.add(callbackLockKey);
    try {
      switch (action) {
        case 'toggle_wh':
          return await handleToggleWh(ctx, workflow, invoiceId);
        case 'view_photo':
          return await handleViewPhoto(ctx, workflow, invoiceId);
        case 'undo':
          return await handleUndo(ctx, workflow, invoiceId, bot);
        case 'confirm':
          return await handleConfirm(ctx, workflow, invoiceId);
        case 'reject':
          return await handleReject(ctx, workflow, invoiceId);
        case 'edit':
          return await handleEditStart(ctx, workflow, invoiceId);
        case 'del_picker':
          return await handleDeletePicker(ctx, workflow, invoiceId);
        case 'del_item': {
          const itemIdx = parseInt(extra, 10);
          return await handleDeleteItem(ctx, workflow, invoiceId, itemIdx, bot);
        }
        case 'edit_refresh':
          return await handleEditRefresh(ctx, workflow, invoiceId);
        case 'finish_edit':
          return await handleFinishEdit(ctx, workflow);
        default:
          await ctx.answerCallbackQuery({ text: 'Неизвестная команда' });
      }
    } finally {
      inFlightCallbacks.delete(callbackLockKey);
    }
  });

  // Telegram Mini App (WebApp) data handler
  bot.on('message:web_app_data', async (ctx) => {
    const rawData = ctx.message.web_app_data.data;
    console.log(`[WebApp] Получены данные от @${ctx.from?.username || ctx.from?.id}:`, rawData.slice(0, 160));

    try {
      const parsed = JSON.parse(rawData);
      const invoiceId = Number(parsed.invoiceId);
      if (!invoiceId || isNaN(invoiceId)) {
        await ctx.reply('⚠️ Ошибка: не указан ID накладной в данных Mini App.');
        return;
      }

      const parseResult = InvoiceDataSchema.safeParse(parsed.data || parsed);
      if (!parseResult.success) {
        await ctx.reply(`⚠️ <b>Ошибка валидации данных Mini App:</b> ${escapeHtml(parseResult.error.message)}`, {
          parse_mode: 'HTML'
        });
        return;
      }

      const updatedData = parseResult.data;
      const res = workflow.applyDataEdit(invoiceId, updatedData);

      if (!res.success || !res.cardText) {
        await ctx.reply(`⚠️ Ошибка сохранения: ${escapeHtml(res.message)}`, {
          parse_mode: 'HTML'
        });
        return;
      }

      // Save product mappings if provided
      if (Array.isArray(parsed.mappings)) {
        for (const m of parsed.mappings) {
          if (m.rawName && m.iikoProductName) {
            workflow.saveProductMapping(m.rawName, m.iikoProductName, m.iikoProductId);
          }
        }
      }

      await safeReact(ctx, '✅');

      const calcTotal = Math.round(updatedData.items.reduce((s, it) => s + (it.sum || it.qty * it.price), 0));
      await ctx.reply(
        `✅ <b>Накладная #${invoiceId} успешно обновлена через Telegram Mini App!</b>\n` +
        `📦 Позиций: <b>${updatedData.items.length}</b>  |  💰 Итого: <b>${calcTotal.toLocaleString('ru-RU')} ₽</b>\n\n` +
        res.cardText,
        {
          parse_mode: 'HTML',
          reply_markup: createInvoiceKeyboard(invoiceId, !!res.hasPhoto, undefined, workflow.canUndo(invoiceId))
        }
      );
    } catch (err: any) {
      console.error('Ошибка обработки web_app_data:', err);
      await ctx.reply(`⚠️ <b>Ошибка сохранения из Mini App:</b> ${escapeHtml(err.message || String(err))}`, {
        parse_mode: 'HTML'
      });
    }
  });

  // Text message handler for active edit sessions or direct replies
  bot.on('message:text', async (ctx, next) => {
    if (ctx.message.text.startsWith('/')) {
      return next();
    }

    const userId = ctx.from?.id || 0;
    const session = workflow.getEditSession(userId);
    let invoiceId: number | null = session ? session.invoiceId : null;
    let cardMessageId: number | null = session ? session.cardMessageId : null;
    let chatId: number = session ? session.chatId : (ctx.chat?.id || 0);

    // If no active session, check if message is a reply to an invoice card
    if (!invoiceId && ctx.message.reply_to_message) {
      const replyText = ctx.message.reply_to_message.text || ctx.message.reply_to_message.caption || '';
      const match = replyText.match(/Накладная #(\d+)/i) || replyText.match(/накладной #(\d+)/i);
      if (match) {
        invoiceId = parseInt(match[1], 10);
        const card = workflow.getInvoiceCard(invoiceId);
        cardMessageId = card?.domain.invoice.card_message_id || ctx.message.reply_to_message.message_id;
        chatId = card?.domain.invoice.telegram_chat_id || ctx.chat?.id || 0;
      }
    }

    if (!invoiceId) {
      const text = ctx.message.text.trim();
      const isEditCommand =
        /^\d+[\s:]/.test(text) ||
        /^удалить\s+\d+/i.test(text) ||
        /^\+\s+/i.test(text) ||
        /^(поставщик|склад|дата):/i.test(text);

      if (isEditCommand) {
        await ctx.reply(
          '⚠️ Сессия редактирования не найдена или была сброшена после перезапуска бота.\n' +
          'Пожалуйста, нажмите кнопку <b>«🎙 Наговорить / Написать правку»</b> под карточкой накладной или ответьте (Reply) на карточку накладной.',
          { parse_mode: 'HTML' }
        );
        return;
      }
      return next();
    }

    await safeReact(ctx, '✍️');
    await safeAction(ctx, 'typing');

    const res = await workflow.applyHybridEdit(invoiceId, ctx.message.text);
    if (!res.success || !res.editableText) {
      await ctx.reply(
        `⚠️ <b>Не удалось применить правку:</b>\n\n${escapeHtml(res.message)}`,
        {
          parse_mode: 'HTML',
          reply_markup: createEditKeyboard(invoiceId, workflow.canUndo(invoiceId))
        }
      );
      return;
    }

    // Update real card using domain.invoice.card_message_id
    await updateTelegramInvoiceCard(bot, workflow, invoiceId, res.cardText, !!res.hasPhoto);

    await ctx.reply(
      `✅ ${escapeHtml(res.message)}\n\n` +
      `⬆️ <b>Карточка накладной #${invoiceId} выше обновлена!</b>\n\n` +
      `Текущий состав:\n<pre><code>${escapeHtml(res.editableText)}</code></pre>`,
      {
        parse_mode: 'HTML',
        reply_markup: createEditKeyboard(invoiceId, workflow.canUndo(invoiceId))
      }
    );
  });

  bot.catch((err) => {
    console.error('Неперехваченная ошибка в боте:', err);
  });

  return bot;
}
