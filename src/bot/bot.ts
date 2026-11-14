import { Bot, Context, InlineKeyboard, InputFile } from 'grammy';
import { config } from '../config.js';
import { InvoiceWorkflow } from '../workflow/invoice-workflow.js';
import { formatDailyStats, escapeHtml } from './formatter.js';
import { InvoiceDataSchema } from '../types/index.js';

export interface EditSession {
  invoiceId: number;
  cardMessageId: number;
  chatId: number;
  editPromptMessageId?: number;
}

export function createInvoiceKeyboard(invoiceId: number, hasPhoto = true, webAppUrl?: string): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('✅ Создать в iiko', `confirm:${invoiceId}`)
    .text('❌ Отклонить', `reject:${invoiceId}`)
    .row();

  const url = webAppUrl || config.webapp.url;
  if (url) {
    const fullUrl = url.includes('?') ? `${url}&invoiceId=${invoiceId}` : `${url}?invoiceId=${invoiceId}`;
    kb.webApp('📱 Редактор (Mini App)', fullUrl);
  } else {
    kb.text('✏️ Редактировать', `edit:${invoiceId}`);
  }

  kb.text('🔄 Склад', `toggle_wh:${invoiceId}`);
  if (hasPhoto) {
    kb.text('🖼 Фото', `view_photo:${invoiceId}`);
  }

  // If Mini App URL is active, still provide text edit on second row as alternative
  if (url) {
    kb.row().text('✏️ Текст-правка', `edit:${invoiceId}`);
  }

  return kb;
}

export function createEditKeyboard(invoiceId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('🗑 Удалить строку...', `del_picker:${invoiceId}`)
    .text('🔙 Завершить', `finish_edit:${invoiceId}`);
}

async function safeReact(ctx: Context, emoji: string): Promise<void> {
  try {
    await ctx.react(emoji as any);
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

  const keyboard = createInvoiceKeyboard(invoiceId, !!res.hasPhoto);
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

async function handleConfirm(ctx: Context, workflow: InvoiceWorkflow, invoiceId: number): Promise<void> {
  const card = workflow.getInvoiceCard(invoiceId);
  if (!card) {
    await ctx.answerCallbackQuery({ text: 'Накладная не найдена' });
    return;
  }

  if (card.domain.invoice.status === 'synced') {
    await ctx.answerCallbackQuery({ text: 'Накладная уже была создана в iiko!' });
    return;
  }

  await ctx.answerCallbackQuery({ text: 'Отправляю в iiko...' });

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
    const updatedText = `${baseText}\n\n✅ <b>Создано в iiko!</b> Номер: <code>${escapeHtml(result.documentNumber || '')}</code>${modeNotice}${unmatchedNotice}${unitNotice}\n<i>Зайдите в iiko и нажмите «Провести».</i>`;

    try {
      await ctx.editMessageText(updatedText, {
        parse_mode: 'HTML',
        reply_markup: undefined
      });
    } catch {
      await ctx.reply(`✅ <b>Накладная #${invoiceId} создана в iiko!</b>\nНомер: <code>${escapeHtml(result.documentNumber || '')}</code>`, {
        parse_mode: 'HTML'
      });
    }
  } else {
    await ctx.reply(`⚠️ <b>Ошибка iiko:</b> ${escapeHtml(result.message || 'Неизвестная ошибка')}`, {
      parse_mode: 'HTML'
    });
  }
}

async function handleReject(
  ctx: Context,
  workflow: InvoiceWorkflow,
  invoiceId: number,
  sessions: Map<number, EditSession>
): Promise<void> {
  workflow.rejectInvoice(invoiceId);
  const userId = ctx.from?.id || 0;
  sessions.delete(userId);
  workflow.deleteEditSession(userId);
  await safeReact(ctx, '🗑');
  await ctx.answerCallbackQuery({ text: 'Накладная отклонена' });

  const card = workflow.getInvoiceCard(invoiceId);
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

async function handleEditStart(
  ctx: Context,
  workflow: InvoiceWorkflow,
  invoiceId: number,
  sessions: Map<number, EditSession>
): Promise<void> {
  const card = workflow.getInvoiceCard(invoiceId);
  if (!card) {
    await ctx.answerCallbackQuery({ text: 'Накладная не найдена' });
    return;
  }

  const promptMsg = await ctx.reply(
    `✏️ <b>Редактирование накладной #${invoiceId}</b>\n\n` +
    `📋 <i>Кликните/тапните по тексту ниже, чтобы скопировать, измените и отправьте:</i>\n\n` +
    `<pre><code>${escapeHtml(card.editableText)}</code></pre>\n\n` +
    `<i>Либо отправьте точечную команду:</i>\n` +
    `• <code>1: 15 * 600</code> — изменить строку 1 (кол-во * цена)\n` +
    `• <code>1 15 600</code> — короткий формат (строка кол-во цена)\n` +
    `• <code>удалить 2</code> — удалить строку 2\n` +
    `• <code>+ Томаты 10 * 120</code> — добавить позицию\n` +
    `• <code>поставщик: Название</code> — сменить поставщика`,
    {
      parse_mode: 'HTML',
      reply_markup: createEditKeyboard(invoiceId)
    }
  );

  const session: EditSession = {
    invoiceId,
    cardMessageId: ctx.callbackQuery?.message?.message_id || 0,
    chatId: ctx.chat?.id || 0,
    editPromptMessageId: promptMsg.message_id
  };

  const userId = ctx.from?.id || 0;
  sessions.set(userId, session);
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
  sessions: Map<number, EditSession>
): Promise<void> {
  const res = workflow.deleteItem(invoiceId, itemIdx);
  if (!res.success || !res.removedItem || !res.editableText) {
    await ctx.answerCallbackQuery({ text: res.error || 'Ошибка удаления позиции' });
    return;
  }

  // Update main card message in-place
  const userId = ctx.from?.id || 0;
  const session = sessions.get(userId) || workflow.getEditSession(userId);
  if (session?.cardMessageId && session?.chatId && res.cardText) {
    try {
      await ctx.api.editMessageText(session.chatId, session.cardMessageId, res.cardText, {
        parse_mode: 'HTML',
        reply_markup: createInvoiceKeyboard(invoiceId, !!res.hasPhoto)
      });
    } catch {}
  }

  try {
    await ctx.editMessageText(
      `🗑 Позиция <b>«${escapeHtml(res.removedItem.name)}»</b> удалена.\n\n` +
      `Текущий состав накладной:\n<pre><code>${escapeHtml(res.editableText)}</code></pre>`,
      {
        parse_mode: 'HTML',
        reply_markup: createEditKeyboard(invoiceId)
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
      `📋 <i>Кликните/тапните по тексту ниже, чтобы скопировать, измените и отправьте:</i>\n\n` +
      `<pre><code>${escapeHtml(card.editableText)}</code></pre>\n\n` +
      `<i>Либо отправьте точечную команду:</i>\n` +
      `• <code>1: 15 * 600</code> — изменить строку 1 (кол-во * цена)\n` +
      `• <code>1 15 600</code> — короткий формат (строка кол-во цена)\n` +
      `• <code>удалить 2</code> — удалить строку 2\n` +
      `• <code>+ Томаты 10 * 120</code> — добавить позицию\n` +
      `• <code>поставщик: Название</code> — сменить поставщика`,
      {
        parse_mode: 'HTML',
        reply_markup: createEditKeyboard(invoiceId)
      }
    );
  } catch {}
  await ctx.answerCallbackQuery();
}

async function handleFinishEdit(ctx: Context, workflow: InvoiceWorkflow, sessions: Map<number, EditSession>): Promise<void> {
  const userId = ctx.from?.id || 0;
  sessions.delete(userId);
  workflow.deleteEditSession(userId);
  try {
    await ctx.editMessageText(
      `✅ <b>Редактирование завершено.</b> Карточка накладной обновлена выше и готова к созданию в iiko.`,
      { parse_mode: 'HTML' }
    );
  } catch {}
  await ctx.answerCallbackQuery({ text: 'Готово!' });
}

// --- Main bot factory ---

export function createBot(workflowInstance?: InvoiceWorkflow): Bot {
  if (!config.telegram.token) {
    throw new Error('TELEGRAM_TOKEN не найден в .env');
  }

  const bot = new Bot(config.telegram.token);
  const workflow = workflowInstance || new InvoiceWorkflow();
  const repo = workflow.getRepo();
  const activeEditSessions = new Map<number, EditSession>();

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
      '• <b>Mini App (WebApp):</b> удобный сенсорный редактор с пересчетом сумм и кнопочными степперами.\n' +
      '• <b>Смена склада:</b> кнопка <i>[🔄 Склад]</i> в один клик переключает Кухня ⇄ Хоз склад.\n' +
      '• <b>Сверка цен:</b> предупреждения о росте цен по сравнению с прошлыми поставками.\n' +
      '• <b>Архив фото:</b> кнопка <i>[🖼 Фото]</i> позволяет в любой момент посмотреть оригинал чека.',
      { parse_mode: 'HTML' }
    );
  });

  // /app or /webapp command
  bot.command(['app', 'webapp'], async (ctx) => {
    const webappUrl = config.webapp.url;
    if (webappUrl) {
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
      await ctx.reply(
        'ℹ️ <b>Telegram Mini App редактор</b>\n\n' +
        'Сервер Mini App активен локально на порту <code>' + config.webapp.port + '</code>.\n\n' +
        'Чтобы кнопка открывалась прямо внутри Telegram на смартфонах персонала, укажите в файле <code>.env</code> публичный HTTPS-адрес:\n' +
        '<code>WEBAPP_URL=https://ваш-домен-или-туннель.ru</code>\n\n' +
        '<i>Пока URL не настроен, вы можете редактировать накладные текстом по кнопке [✏️ Редактировать].</i>',
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

  // Photo handler
  bot.on('message:photo', async (ctx) => {
    await safeReact(ctx, '👀');
    await safeAction(ctx, 'upload_photo');

    const statusMsg = await ctx.reply('🔍 <i>Распознаю накладную через нейросеть...</i>', {
      parse_mode: 'HTML'
    });

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

      const result = await workflow.processPhotoInvoice({
        photoBuffer,
        userId: ctx.from?.id,
        messageId: ctx.message.message_id,
        photoFileId: photo.file_id
      });

      const keyboard = createInvoiceKeyboard(result.invoiceId, result.hasPhoto);
      const userId = ctx.from?.id || 0;
      activeEditSessions.delete(userId);
      workflow.deleteEditSession(userId);

      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
      await safeReact(ctx, '⚡');
      await ctx.reply(result.cardText, {
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
    } catch (err: any) {
      console.error('Ошибка обработки фото:', err);
      try {
        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          `❌ <b>Ошибка распознавания:</b> ${escapeHtml(err.message || String(err))}`,
          { parse_mode: 'HTML' }
        );
      } catch {
        await ctx.reply(`❌ <b>Ошибка:</b> ${escapeHtml(err.message || String(err))}`, { parse_mode: 'HTML' });
      }
    }
  });

  // Voice handler
  bot.on('message:voice', async (ctx) => {
    await safeReact(ctx, '👂');
    await safeAction(ctx, 'record_voice');

    const statusMsg = await ctx.reply('🎙 <i>Слушаю голосовое сообщение через нейросеть...</i>', {
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

      const result = await workflow.processVoiceInvoice({
        audioBuffer: audioBuf,
        mimeType: 'audio/ogg',
        userId: ctx.from?.id,
        messageId: ctx.message.message_id
      });

      const keyboard = createInvoiceKeyboard(result.invoiceId, false);
      const userId = ctx.from?.id || 0;
      activeEditSessions.delete(userId);
      workflow.deleteEditSession(userId);

      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
      await safeReact(ctx, '⚡');
      await ctx.reply(result.cardText, {
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
    } catch (err: any) {
      console.error('Ошибка голосового распознавания:', err);
      try {
        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          `❌ <b>Ошибка распознавания голоса:</b> ${escapeHtml(err.message || String(err))}`,
          { parse_mode: 'HTML' }
        );
      } catch {
        await ctx.reply(`❌ <b>Ошибка:</b> ${escapeHtml(err.message || String(err))}`, { parse_mode: 'HTML' });
      }
    }
  });

  // Callback query dispatcher
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const [action, idStr, extra] = data.split(':');
    const invoiceId = parseInt(idStr, 10);

    if (isNaN(invoiceId)) {
      await ctx.answerCallbackQuery({ text: 'Некорректный ID накладной' });
      return;
    }

    switch (action) {
      case 'toggle_wh':
        return handleToggleWh(ctx, workflow, invoiceId);
      case 'view_photo':
        return handleViewPhoto(ctx, workflow, invoiceId);
      case 'confirm':
        return handleConfirm(ctx, workflow, invoiceId);
      case 'reject':
        return handleReject(ctx, workflow, invoiceId, activeEditSessions);
      case 'edit':
        return handleEditStart(ctx, workflow, invoiceId, activeEditSessions);
      case 'del_picker':
        return handleDeletePicker(ctx, workflow, invoiceId);
      case 'del_item': {
        const itemIdx = parseInt(extra, 10);
        return handleDeleteItem(ctx, workflow, invoiceId, itemIdx, activeEditSessions);
      }
      case 'edit_refresh':
        return handleEditRefresh(ctx, workflow, invoiceId);
      case 'finish_edit':
        return handleFinishEdit(ctx, workflow, activeEditSessions);
      default:
        await ctx.answerCallbackQuery({ text: 'Неизвестная команда' });
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
          reply_markup: createInvoiceKeyboard(invoiceId, !!res.hasPhoto)
        }
      );
    } catch (err: any) {
      console.error('Ошибка обработки web_app_data:', err);
      await ctx.reply(`⚠️ <b>Ошибка сохранения из Mini App:</b> ${escapeHtml(err.message || String(err))}`, {
        parse_mode: 'HTML'
      });
    }
  });

  // Text message handler for active edit sessions
  bot.on('message:text', async (ctx, next) => {
    if (ctx.message.text.startsWith('/')) {
      return next();
    }

    const userId = ctx.from?.id || 0;
    const session = activeEditSessions.get(userId) || workflow.getEditSession(userId);
    if (!session) {
      const text = ctx.message.text.trim();
      const isEditCommand =
        /^\d+[\s:]/.test(text) ||
        /^удалить\s+\d+/i.test(text) ||
        /^\+\s+/i.test(text) ||
        /^(поставщик|склад|дата):/i.test(text);

      if (isEditCommand) {
        await ctx.reply(
          '⚠️ Сессия редактирования не найдена или была сброшена после перезапуска бота.\n' +
          'Пожалуйста, нажмите кнопку <b>«✏️ Редактировать»</b> под карточкой накладной заново.',
          { parse_mode: 'HTML' }
        );
        return;
      }
      return next();
    }

    const res = workflow.applyTextEdit(session.invoiceId, ctx.message.text);
    if (!res.success || !res.editableText) {
      await ctx.reply(`⚠️ ${escapeHtml(res.message)}`, { parse_mode: 'HTML' });
      return;
    }

    // Update main card message in-place
    if (res.cardText) {
      try {
        await ctx.api.editMessageText(session.chatId, session.cardMessageId, res.cardText, {
          parse_mode: 'HTML',
          reply_markup: createInvoiceKeyboard(session.invoiceId, !!res.hasPhoto)
        });
      } catch (err) {
        console.warn('Не удалось обновить карточку на месте:', err);
      }
    }

    await ctx.reply(
      `✅ ${escapeHtml(res.message)}\n\n` +
      `⬆️ <b>Карточка накладной #${session.invoiceId} выше обновлена!</b>\n\n` +
      `Текущий состав:\n<pre><code>${escapeHtml(res.editableText)}</code></pre>`,
      {
        parse_mode: 'HTML',
        reply_markup: createEditKeyboard(session.invoiceId)
      }
    );
  });

  bot.catch((err) => {
    console.error('Неперехваченная ошибка в боте:', err);
  });

  return bot;
}
