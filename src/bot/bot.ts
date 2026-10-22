import { Bot, InlineKeyboard } from 'grammy';
import { config } from '../config.js';
import { GeminiInvoiceRecognizer } from '../gemini/recognizer.js';
import { InvoicesRepository } from '../db/invoices.repo.js';
import { IikoClient } from '../iiko/client.js';
import { formatInvoiceMessage } from './formatter.js';

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
      await ctx.reply('⛔ Доступ ограничен. Ваш ID: `' + ctx.from.id + '`', { parse_mode: 'Markdown' });
      return;
    }
    await next();
  });

  // /start command
  bot.command('start', async (ctx) => {
    await ctx.reply(
      '👋 *Привет!*\n\n' +
      'Я бот для распознавания рукописных накладных ресторана с интеграцией в iiko.\n\n' +
      '📸 *Как пользоваться:*\n' +
      '1. Отправь фото накладной (можно сразу несколько подряд).\n' +
      '2. Нейросеть *Gemini 3.8 Flash* распознает наименования, цены, количества и склад.\n' +
      '3. Бот сверит цены с предыдущими закупками из базы данных и предупредит о подорожании или дубликатах.\n' +
      '4. Нажми кнопку *[✅ Создать в iiko]* для проведения документа.\n\n' +
      'Команды:\n' +
      '/history — последние 10 накладных\n' +
      '/help — справка по возможностям',
      { parse_mode: 'Markdown' }
    );
  });

  // /help command
  bot.command('help', async (ctx) => {
    await ctx.reply(
      'ℹ️ *Справка по боту:*\n\n' +
      '• *Распознавание:* Модель Gemini 3.8 Flash обучена на контексте ваших постоянных позиций и поставщиков.\n' +
      '• *База данных:* Сохраняет каждую позицию и отслеживает изменение цен.\n' +
      '• *Склады:* Кухня (продукты) и Хоз склад (бытовая химия, расходники) определяются автоматически.\n' +
      '• *iiko:* Создает приходную накладную через iiko Cloud API.',
      { parse_mode: 'Markdown' }
    );
  });

  // /history command
  bot.command('history', async (ctx) => {
    const recent = repo.getRecentInvoices(10);
    if (recent.length === 0) {
      await ctx.reply('📭 В базе пока нет сохраненных накладных.');
      return;
    }

    const lines = ['📜 *История последних накладных:*', ''];
    for (const inv of recent) {
      let statusIcon = '⏳';
      if (inv.status === 'synced') statusIcon = '✅';
      else if (inv.status === 'rejected') statusIcon = '❌';

      const docInfo = inv.iiko_document_id ? ` (iiko #${inv.iiko_document_id})` : '';
      lines.push(
        `${statusIcon} *#${inv.id}* | ${inv.date} | *${inv.supplier}* | ${Math.round(inv.total_calculated)} ₽${docInfo}`
      );
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  });

  // Photo message handler
  bot.on('message:photo', async (ctx) => {
    const statusMsg = await ctx.reply('🔍 _Распознаю накладную через Gemini 3.8 Flash..._', {
      parse_mode: 'Markdown'
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
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    } catch (err: any) {
      console.error('Ошибка обработки фото:', err);
      try {
        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          `❌ *Ошибка распознавания:* ${err.message || err}`,
          { parse_mode: 'Markdown' }
        );
      } catch {
        await ctx.reply(`❌ *Ошибка:* ${err.message || err}`, { parse_mode: 'Markdown' });
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
        const modeNotice = result.isMock ? ' _(демо-режим без пароля iiko)_' : '';
        const updatedText = `${currentText}\n\n✅ *Создано в iiko!* Номер: \`${result.documentNumber}\`${modeNotice}\n_Зайдите в iiko и нажмите «Провести»._`;

        try {
          await ctx.editMessageText(updatedText, {
            parse_mode: 'Markdown',
            reply_markup: undefined // Remove buttons
          });
        } catch {
          await ctx.reply(`✅ *Накладная #${invoiceId} создана в iiko!*\nНомер: \`${result.documentNumber}\``, {
            parse_mode: 'Markdown'
          });
        }
      } else {
        await ctx.reply(`⚠️ *Ошибка iiko:* ${result.message}`, { parse_mode: 'Markdown' });
      }
    } else if (action === 'reject') {
      repo.updateInvoiceStatus(invoiceId, 'rejected');
      await ctx.answerCallbackQuery({ text: 'Накладная отклонена' });

      const currentText = ctx.callbackQuery.message?.text || '';
      try {
        await ctx.editMessageText(`${currentText}\n\n❌ *Накладная отклонена.*`, {
          parse_mode: 'Markdown',
          reply_markup: undefined
        });
      } catch {
        await ctx.reply(`❌ *Накладная #${invoiceId} отклонена.*`, { parse_mode: 'Markdown' });
      }
    }
  });

  bot.catch((err) => {
    console.error('Неперехваченная ошибка в боте:', err);
  });

  return bot;
}
