import { Bot, InlineKeyboard, InputFile } from 'grammy';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { GeminiInvoiceRecognizer } from '../gemini/recognizer.js';
import { InvoicesRepository } from '../db/invoices.repo.js';
import { IikoClient } from '../iiko/client.js';
import { formatInvoiceMessage, formatDailyStats, escapeHtml } from './formatter.js';
import { formatEditableInvoice, parseInvoiceEditText } from './parser.js';
import { InvoiceData } from '../types/index.js';

interface EditSession {
  invoiceId: number;
  cardMessageId: number;
  chatId: number;
  editPromptMessageId?: number;
}

export function createInvoiceKeyboard(invoiceId: number, hasPhoto = true): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('✅ Создать в iiko', `confirm:${invoiceId}`)
    .text('❌ Отклонить', `reject:${invoiceId}`)
    .row()
    .text('✏️ Редактировать', `edit:${invoiceId}`)
    .text('🔄 Склад', `toggle_wh:${invoiceId}`);
  if (hasPhoto) {
    kb.text('🖼 Фото', `view_photo:${invoiceId}`);
  }
  return kb;
}

function recordToInvoiceData(record: NonNullable<ReturnType<InvoicesRepository['getInvoiceById']>>): InvoiceData {
  return {
    date: record.invoice.date,
    supplier: record.invoice.supplier,
    warehouse: record.invoice.warehouse,
    items: record.items.map(it => ({
      name: it.name,
      qty: it.qty,
      price: it.price,
      sum: it.sum,
      unit: it.unit
    })),
    total_written: record.invoice.total_written
  };
}

export function createBot(): Bot {
  if (!config.telegram.token) {
    throw new Error('TELEGRAM_TOKEN не найден в .env');
  }

  const bot = new Bot(config.telegram.token);
  const repo = new InvoicesRepository();
  const recognizer = new GeminiInvoiceRecognizer();
  const iikoClient = new IikoClient();
  const activeEditSessions = new Map<number, EditSession>();

  // Access control middleware
  bot.use(async (ctx, next) => {
    // Always allow /id or /myid command so owner can find their Telegram ID
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
      '2. Нейросеть <b>Gemini 3.8 Flash</b> распознает наименования, цены, количества и склад.\n' +
      '3. Бот сверит цены с предыдущими закупками из базы данных и предупредит о подорожании или дубликатах.\n' +
      '4. Нажми кнопку <b>[✅ Создать в iiko]</b> для проведения документа.\n\n' +
      '<b>Команды:</b>\n' +
      '/today — сводка расходов за сегодня\n' +
      '/history — последние 10 накладных\n' +
      '/export — выгрузить CSV файл для бухгалтера\n' +
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
      '• <b>Смена склада:</b> кнопка <i>[🔄 Склад]</i> в один клик переключает Кухня ⇄ Хоз склад.\n' +
      '• <b>Сверка цен:</b> предупреждения о росте цен по сравнению с прошлыми поставками.\n' +
      '• <b>Архив фото:</b> кнопка <i>[🖼 Фото]</i> позволяет в любой момент посмотреть оригинал чека.',
      { parse_mode: 'HTML' }
    );
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
    const bom = '\uFEFF'; // UTF-8 BOM so Excel opens Cyrillic without garbled text
    const buffer = Buffer.from(bom + csvContent, 'utf-8');
    const today = new Date().toISOString().slice(0, 10);

    await ctx.replyWithDocument(new InputFile(buffer, `invoices_${today}.csv`), {
      caption: `📁 <b>Выгрузка накладных для Excel/1C</b> (до 200 записей).`,
      parse_mode: 'HTML'
    });
  });

  // Photo message handler
  bot.on('message:photo', async (ctx) => {
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

      // Memory context from past invoices
      const knownItemsWithUnits = repo.getKnownItemsWithUnits(60);
      const knownSuppliers = repo.getKnownSuppliers(30);

      // Recognize with Gemini
      const data = await recognizer.recognize(photoBuffer, {
        knownItemsWithUnits,
        knownSuppliers
      });

      // Price comparison & duplicate detection
      const comparison = repo.compareWithHistory(data);

      // Save to SQLite
      const { invoiceId } = repo.saveInvoice(data, {
        userId: ctx.from?.id,
        messageId: ctx.message.message_id,
        photoFileId: photo.file_id
      });

      // Save photo locally for archiving
      const photosDir = path.resolve(path.dirname(config.db.path), 'photos');
      const localPhotoPath = path.resolve(photosDir, `${invoiceId}.jpg`);
      try {
        fs.writeFileSync(localPhotoPath, photoBuffer);
      } catch (err) {
        console.warn('Не удалось сохранить локальное фото:', err);
      }

      const cardText = formatInvoiceMessage(invoiceId, data, comparison);
      const keyboard = createInvoiceKeyboard(invoiceId, true);
      activeEditSessions.delete(ctx.from?.id || 0);

      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
      await ctx.reply(cardText, {
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

  // Voice message handler (Chefs dictating deliveries verbally)
  bot.on('message:voice', async (ctx) => {
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

      const knownItemsWithUnits = repo.getKnownItemsWithUnits(60);
      const knownSuppliers = repo.getKnownSuppliers(30);

      const data = await recognizer.recognizeVoice(audioBuf, 'audio/ogg', {
        knownItemsWithUnits,
        knownSuppliers
      });

      const comparison = repo.compareWithHistory(data);
      const { invoiceId } = repo.saveInvoice(data, {
        userId: ctx.from?.id,
        messageId: ctx.message.message_id
      });

      const cardText = `🎙 <b>Голосовая накладная:</b>\n\n` + formatInvoiceMessage(invoiceId, data, comparison);
      const keyboard = createInvoiceKeyboard(invoiceId, false);
      activeEditSessions.delete(ctx.from?.id || 0);

      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
      await ctx.reply(cardText, {
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

  // Callback query handler
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const [action, idStr] = data.split(':');
    const invoiceId = parseInt(idStr, 10);

    if (isNaN(invoiceId)) {
      await ctx.answerCallbackQuery({ text: 'Некорректный ID накладной' });
      return;
    }

    const record = repo.getInvoiceById(invoiceId);
    if (!record) {
      await ctx.answerCallbackQuery({ text: 'Накладная не найдена в базе' });
      return;
    }

    // 1. Toggle Warehouse
    if (action === 'toggle_wh') {
      const newWh = repo.toggleWarehouse(invoiceId);
      const updatedRecord = repo.getInvoiceById(invoiceId);
      if (updatedRecord) {
        const parsedInvoiceData = {
          date: updatedRecord.invoice.date,
          supplier: updatedRecord.invoice.supplier,
          warehouse: updatedRecord.invoice.warehouse,
          items: updatedRecord.items.map(it => ({
            name: it.name,
            qty: it.qty,
            price: it.price,
            sum: it.sum
          })),
          total_written: updatedRecord.invoice.total_written
        };
        const comp = repo.compareWithHistory(parsedInvoiceData);
        const newCardText = formatInvoiceMessage(invoiceId, parsedInvoiceData, comp);

        const keyboard = createInvoiceKeyboard(invoiceId, !!updatedRecord.invoice.photo_file_id || !!updatedRecord.invoice.local_photo_path);

        try {
          await ctx.editMessageText(newCardText, {
            parse_mode: 'HTML',
            reply_markup: keyboard
          });
        } catch {
          // Message unchanged or edit not needed
        }
      }
      await ctx.answerCallbackQuery({ text: `Склад изменен на: ${newWh === 'household' ? 'Хоз склад' : 'Склад Кухня'}` });
      return;
    }

    // 2. View Photo
    if (action === 'view_photo') {
      const photosDir = path.resolve(path.dirname(config.db.path), 'photos');
      const photoPath = path.resolve(photosDir, `${invoiceId}.jpg`);

      if (fs.existsSync(photoPath)) {
        await ctx.replyWithPhoto(new InputFile(photoPath), {
          caption: `🖼 <b>Оригинал фото к накладной #${invoiceId}</b>`,
          parse_mode: 'HTML'
        });
        await ctx.answerCallbackQuery();
      } else if (record.invoice.photo_file_id) {
        await ctx.replyWithPhoto(record.invoice.photo_file_id, {
          caption: `🖼 <b>Оригинал фото к накладной #${invoiceId}</b>`,
          parse_mode: 'HTML'
        });
        await ctx.answerCallbackQuery();
      } else {
        await ctx.answerCallbackQuery({ text: 'Фото для этой накладной не найдено' });
      }
      return;
    }

    // 3. Confirm & Push to iiko
    if (action === 'confirm') {
      if (record.invoice.status === 'synced') {
        await ctx.answerCallbackQuery({ text: 'Накладная уже была создана в iiko!' });
        return;
      }

      await ctx.answerCallbackQuery({ text: 'Отправляю в iiko...' });

      const parsedInvoiceData = recordToInvoiceData(record);
      const result = await iikoClient.createInvoice(parsedInvoiceData);

      if (result.success) {
        repo.updateInvoiceStatus(invoiceId, 'synced', result.documentNumber);

        const currentText = ctx.callbackQuery.message?.text || '';
        const modeNotice = result.isMock ? ' <i>(демо-режим)</i>' : '';
        const unmatchedNotice = result.unmatched?.length
          ? `\n⚠️ <b>Не найдены в iiko и не добавлены:</b> ${escapeHtml(result.unmatched.join(', '))}`
          : '';
        const updatedText = `${escapeHtml(currentText)}\n\n✅ <b>Создано в iiko!</b> Номер: <code>${escapeHtml(result.documentNumber || '')}</code>${modeNotice}${unmatchedNotice}\n<i>Зайдите в iiko и нажмите «Провести».</i>`;

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
        await ctx.reply(`⚠️ <b>Ошибка iiko:</b> ${escapeHtml(result.message || 'Неизвестная ошибка')}`, { parse_mode: 'HTML' });
      }
      return;
    }

    // 4. Reject
    if (action === 'reject') {
      repo.updateInvoiceStatus(invoiceId, 'rejected');
      activeEditSessions.delete(ctx.from?.id || 0);
      await ctx.answerCallbackQuery({ text: 'Накладная отклонена' });

      const currentText = ctx.callbackQuery.message?.text || '';
      try {
        await ctx.editMessageText(`${escapeHtml(currentText)}\n\n❌ <b>Накладная отклонена.</b>`, {
          parse_mode: 'HTML',
          reply_markup: undefined
        });
      } catch {
        await ctx.reply(`❌ <b>Накладная #${invoiceId} отклонена.</b>`, { parse_mode: 'HTML' });
      }
      return;
    }

    // 5. Start Edit Mode
    if (action === 'edit') {
      const invData = recordToInvoiceData(record);
      const editableText = formatEditableInvoice(invData);

      const promptMsg = await ctx.reply(
        `✏️ <b>Редактирование накладной #${invoiceId}</b>\n\n` +
        `📋 <i>Кликните/тапните по тексту ниже, чтобы скопировать, измените и отправьте:</i>\n\n` +
        `<pre><code>${escapeHtml(editableText)}</code></pre>\n\n` +
        `<i>Либо отправьте точечную команду:</i>\n` +
        `• <code>1: 15 * 600</code> — изменить строку 1 (кол-во * цена)\n` +
        `• <code>1 15 600</code> — короткий формат (строка кол-во цена)\n` +
        `• <code>удалить 2</code> — удалить строку 2\n` +
        `• <code>+ Томаты 10 * 120</code> — добавить позицию\n` +
        `• <code>поставщик: Название</code> — сменить поставщика`,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard()
            .text('🗑 Удалить строку...', `del_picker:${invoiceId}`)
            .text('🔙 Завершить', `finish_edit:${invoiceId}`)
        }
      );

      activeEditSessions.set(ctx.from?.id || 0, {
        invoiceId,
        cardMessageId: ctx.callbackQuery.message?.message_id || 0,
        chatId: ctx.chat?.id || 0,
        editPromptMessageId: promptMsg.message_id
      });

      await ctx.answerCallbackQuery({ text: 'Режим редактирования открыт' });
      return;
    }

    // 6. Delete Picker Menu
    if (action === 'del_picker') {
      if (record.items.length === 0) {
        await ctx.answerCallbackQuery({ text: 'В накладной нет строк для удаления' });
        return;
      }

      const kb = new InlineKeyboard();
      record.items.forEach((item, idx) => {
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
      return;
    }

    // 7. Delete Item Action
    if (action === 'del_item') {
      const parts = data.split(':');
      const itemIdx = parseInt(parts[2], 10);

      if (itemIdx >= 0 && itemIdx < record.items.length) {
        const removedItem = record.items.splice(itemIdx, 1)[0];
        const updatedData = recordToInvoiceData(record);
        repo.updateInvoiceData(invoiceId, updatedData);

        // Update main card message
        const session = activeEditSessions.get(ctx.from?.id || 0);
        const cardMsgId = session?.cardMessageId;
        if (cardMsgId && session?.chatId) {
          const comp = repo.compareWithHistory(updatedData);
          const newCardText = formatInvoiceMessage(invoiceId, updatedData, comp);
          try {
            await ctx.api.editMessageText(session.chatId, cardMsgId, newCardText, {
              parse_mode: 'HTML',
              reply_markup: createInvoiceKeyboard(invoiceId, !!record.invoice.photo_file_id || !!record.invoice.local_photo_path)
            });
          } catch {}
        }

        const newEditable = formatEditableInvoice(updatedData);
        try {
          await ctx.editMessageText(
            `🗑 Позиция <b>«${escapeHtml(removedItem.name)}»</b> удалена.\n\n` +
            `Текущий состав накладной:\n<pre><code>${escapeHtml(newEditable)}</code></pre>`,
            {
              parse_mode: 'HTML',
              reply_markup: new InlineKeyboard()
                .text('🗑 Удалить еще...', `del_picker:${invoiceId}`)
                .text('🔙 Завершить', `finish_edit:${invoiceId}`)
            }
          );
        } catch {}
        await ctx.answerCallbackQuery({ text: `Удалено: ${removedItem.name}` });
      }
      return;
    }

    // 8. Refresh Edit View
    if (action === 'edit_refresh') {
      const invData = recordToInvoiceData(record);
      const editableText = formatEditableInvoice(invData);
      try {
        await ctx.editMessageText(
          `✏️ <b>Редактирование накладной #${invoiceId}</b>\n\n` +
          `📋 <i>Кликните/тапните по тексту ниже, чтобы скопировать, измените и отправьте:</i>\n\n` +
          `<pre><code>${escapeHtml(editableText)}</code></pre>\n\n` +
          `<i>Либо отправьте точечную команду:</i>\n` +
          `• <code>1: 15 * 600</code> — изменить строку 1 (кол-во * цена)\n` +
          `• <code>1 15 600</code> — короткий формат (строка кол-во цена)\n` +
          `• <code>удалить 2</code> — удалить строку 2\n` +
          `• <code>+ Томаты 10 * 120</code> — добавить позицию\n` +
          `• <code>поставщик: Название</code> — сменить поставщика`,
          {
            parse_mode: 'HTML',
            reply_markup: new InlineKeyboard()
              .text('🗑 Удалить строку...', `del_picker:${invoiceId}`)
              .text('🔙 Завершить', `finish_edit:${invoiceId}`)
          }
        );
      } catch {}
      await ctx.answerCallbackQuery();
      return;
    }

    // 9. Finish Edit
    if (action === 'finish_edit') {
      activeEditSessions.delete(ctx.from?.id || 0);
      try {
        await ctx.editMessageText(
          `✅ <b>Редактирование завершено.</b> Карточка накладной обновлена выше и готова к созданию в iiko.`,
          { parse_mode: 'HTML' }
        );
      } catch {}
      await ctx.answerCallbackQuery({ text: 'Готово!' });
      return;
    }
  });

  // Text message handler (editing commands / manual inputs)
  bot.on('message:text', async (ctx, next) => {
    if (ctx.message.text.startsWith('/')) {
      return next();
    }

    const session = activeEditSessions.get(ctx.from?.id || 0);
    if (!session) {
      return next();
    }

    const record = repo.getInvoiceById(session.invoiceId);
    if (!record) {
      activeEditSessions.delete(ctx.from?.id || 0);
      return next();
    }

    const currentData = recordToInvoiceData(record);
    const parseRes = parseInvoiceEditText(ctx.message.text, currentData);

    if (!parseRes.success || !parseRes.data) {
      await ctx.reply(`⚠️ ${parseRes.message}`, { parse_mode: 'HTML' });
      return;
    }

    // Save updated data to SQLite
    repo.updateInvoiceData(session.invoiceId, parseRes.data);

    // Update original card message in-place
    const comp = repo.compareWithHistory(parseRes.data);
    const newCardText = formatInvoiceMessage(session.invoiceId, parseRes.data, comp);

    try {
      await ctx.api.editMessageText(session.chatId, session.cardMessageId, newCardText, {
        parse_mode: 'HTML',
        reply_markup: createInvoiceKeyboard(session.invoiceId, !!record.invoice.photo_file_id || !!record.invoice.local_photo_path)
      });
    } catch (err) {
      console.warn('Не удалось обновить карточку на месте:', err);
    }

    const newEditable = formatEditableInvoice(parseRes.data);
    await ctx.reply(
      `✅ ${escapeHtml(parseRes.message)}\n\n` +
      `⬆️ <b>Карточка накладной #${session.invoiceId} выше обновлена!</b>\n\n` +
      `Текущий состав:\n<pre><code>${escapeHtml(newEditable)}</code></pre>`,
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text('🗑 Удалить строку...', `del_picker:${session.invoiceId}`)
          .text('🔙 Завершить', `finish_edit:${session.invoiceId}`)
      }
    );
  });

  bot.catch((err) => {
    console.error('Неперехваченная ошибка в боте:', err);
  });

  return bot;
}
