import { Bot, InlineKeyboard } from 'grammy';
import { config } from '../config.js';
import { GeminiInvoiceRecognizer } from '../gemini/recognizer.js';
import { InvoicesRepository } from '../db/invoices.repo.js';
import { IikoClient } from '../iiko/client.js';
import { formatInvoiceMessage, escapeHtml } from './formatter.js';

export function createBot(): Bot {
  if (!config.telegram.token) {
    throw new Error('TELEGRAM_TOKEN не найден в .env');
  }

  const bot = new Bot(config.telegram.token);
  const repo = new InvoicesRepository();
  const recognizer = new GeminiInvoiceRecognizer();
  const iikoClient = new IikoClient();

  // Access control middleware
  bot.use(async (ctx, next) => {
    const allowed = config.telegram.allowedUserIds;
    if (allowed.length > 0 && ctx.from && !allowed.includes(ctx.from.id)) {
      await ctx.reply(`⛔ Доступ ограничен. Ваш ID: <code>${ctx.from.id}</code>`, { parse_mode: 'HTML' });
      return;
    }
    await next();
  });

  // /start command
  bot.command('start', async (ctx) => {
    await ctx.reply(
      '👋 <b>Привет!</b>\n\n' +
      'Я бот для распознавания рукописных накладных ресторана с интеграцией в iiko.\n\n' +
      '📸 <b>Как пользоваться:</b>\n' +
      '1. Отправь фото накладной (можно сразу несколько подряд).\n' +
      '2. Нейросеть <b>Gemini 3.8 Flash</b> распознает наименования, цены, количества и склад.\n' +
      '3. Бот сверит цены с предыдущими закупками из базы данных и предупредит о подорожании или дубликатах.\n' +
      '4. Нажми кнопку <b>[✅ Создать в iiko]</b> для проведения документа.\n\n' +
      '<b>Команды:</b>\n' +
      '/history — последние 10 накладных\n' +
      '/help — справка по возможностям',
      { parse_mode: 'HTML' }
    );
  });

  // /help command
  bot.command('help', async (ctx) => {
    await ctx.reply(
      'ℹ️ <b>Справка по боту:</b>\n\n' +
      '• <b>Распознавание:</b> Модель Gemini 3.8 Flash использует историю ранее введенных товаров и поставщиков.\n' +
      '• <b>База данных SQLite:</b> Сохраняет каждую позицию и отслеживает изменение цен.\n' +
      '• <b>Склады:</b> Кухня (продукты) и Хоз склад (бытовая химия, расходники) определяются автоматически.\n' +
      '• <b>iiko:</b> Создает приходную накладную через iiko Cloud API.',
      { parse_mode: 'HTML' }
    );
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

  // Photo message handler
  bot.on('message:photo', async (ctx) => {
    const statusMsg = await ctx.reply('🔍 <i>Распознаю накладную через Gemini 3.8 Flash...</i>', {
      parse_mode: 'HTML'
    });

    try {
      // Get highest resolution photo
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

      // Memory context: fetch known items and suppliers from history
      const knownItems = repo.getKnownItems(80);
      const knownSuppliers = repo.getKnownSuppliers(30);

      // Recognize with Gemini
      const data = await recognizer.recognize(photoBuffer, {
        knownItems,
        knownSuppliers
      });

      // Compare with historical data (duplicate check, price anomalies)
      const comparison = repo.compareWithHistory(data);

      // Save to SQLite
      const { invoiceId } = repo.saveInvoice(data, {
        userId: ctx.from?.id,
        messageId: ctx.message.message_id,
        photoFileId: photo.file_id
      });

      // Format Telegram message
      const cardText = formatInvoiceMessage(invoiceId, data, comparison);

      // Action keyboard
      const keyboard = new InlineKeyboard()
        .text('✅ Создать в iiko', `confirm:${invoiceId}`)
        .text('❌ Отклонить', `reject:${invoiceId}`);

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

    if (record.invoice.status === 'synced') {
      await ctx.answerCallbackQuery({ text: 'Накладная уже была создана в iiko!' });
      return;
    }

    if (action === 'confirm') {
      await ctx.answerCallbackQuery({ text: 'Отправляю в iiko...' });

      const parsedInvoiceData = {
        date: record.invoice.date,
        supplier: record.invoice.supplier,
        warehouse: record.invoice.warehouse,
        items: record.items.map(it => ({
          name: it.name,
          qty: it.qty,
          price: it.price,
          sum: it.sum
        })),
        total_written: record.invoice.total_written
      };

      const result = await iikoClient.createInvoice(parsedInvoiceData);

      if (result.success) {
        repo.updateInvoiceStatus(invoiceId, 'synced', result.documentNumber);

        const currentText = ctx.callbackQuery.message?.text || '';
        const modeNotice = result.isMock ? ' <i>(демо-режим)</i>' : '';
        const updatedText = `${escapeHtml(currentText)}\n\n✅ <b>Создано в iiko!</b> Номер: <code>${escapeHtml(result.documentNumber || '')}</code>${modeNotice}\n<i>Зайдите в iiko и нажмите «Провести».</i>`;

        try {
          await ctx.editMessageText(updatedText, {
            parse_mode: 'HTML',
            reply_markup: undefined // Remove buttons
          });
        } catch {
          await ctx.reply(`✅ <b>Накладная #${invoiceId} создана в iiko!</b>\nНомер: <code>${escapeHtml(result.documentNumber || '')}</code>`, {
            parse_mode: 'HTML'
          });
        }
      } else {
        await ctx.reply(`⚠️ <b>Ошибка iiko:</b> ${escapeHtml(result.message || 'Неизвестная ошибка')}`, { parse_mode: 'HTML' });
      }
    } else if (action === 'reject') {
      repo.updateInvoiceStatus(invoiceId, 'rejected');
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
    }
  });

  bot.catch((err) => {
    console.error('Неперехваченная ошибка в боте:', err);
  });

  return bot;
}
