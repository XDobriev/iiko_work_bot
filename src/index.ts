import { config } from './config.js';
import { getDatabase } from './db/database.js';
import { createBot, updateTelegramInvoiceCard } from './bot/bot.js';
import { InvoiceWorkflow } from './workflow/invoice-workflow.js';
import { startWebAppServer, WebAppServerInstance } from './webapp/server.js';
import { GeminiAutopilot } from './gemini/autopilot.js';

async function main() {
  console.log('==============================================');
  console.log('🤖 Запуск iiko Work Bot (TypeScript v2.0)');
  console.log('==============================================');

  // 1. Initialize SQLite Database
  console.log(`📦 Инициализация базы данных: ${config.db.path}`);
  getDatabase();
  console.log('✅ База данных SQLite готова.');

  // 2. Validate Gemini Config & Initialize Autopilot
  if (!config.gemini.apiKey) {
    console.warn('⚠️ Внимание: GEMINI_API_KEY не задан в .env! Автопилот работает в fallback-режиме.');
  } else {
    console.log('🔑 Gemini API ключ загружен.');
    console.log('🚀 Инициализация динамического автопилота Gemini...');
    try {
      const plan = await GeminiAutopilot.getInstance().refresh();
      if (plan.fromFallback) {
        console.log('⚠️ [Автопилот] Активирован резервный режим (.env).');
      } else {
        console.log(`✨ [Автопилот] Готов к работе! Моделей активно: ${plan.models.length}`);
        console.log(`   📸 Фото: ${plan.photoModels.join(' -> ')}`);
        console.log(`   🎙 Голос: ${plan.voiceModels.join(' -> ')}`);
        console.log(`   ⚡️ Эскалация: ${plan.complexModels.join(' -> ')}`);
      }
    } catch (err: any) {
      console.warn('⚠️ [Автопилот] Ошибка при первичном бенчмарке, включен fallback:', err.message || err);
    }
  }

  // 3. iiko status
  if (config.iiko.password) {
    console.log(`🔗 iiko: боевой режим (${config.iiko.url}, логин: ${config.iiko.login})`);
  } else {
    console.log('ℹ️ iiko: безопасный демо-режим (пароль не указан в .env, накладные эмулируются локально)');
  }

  // 4. Initialize Workflow
  const workflow = new InvoiceWorkflow();

  // 5. Start Telegram Bot
  if (!config.telegram.token) {
    console.error('❌ ОШИБКА: TELEGRAM_TOKEN не найден в .env!');
    console.log('👉 Пожалуйста, укажите токен в файле .env и перезапустите бота.');
    process.exit(1);
  }

  const bot = createBot(workflow);

  // 6. Start Telegram Mini App Server (if enabled)
  let webappInstance: WebAppServerInstance | null = null;
  if (config.webapp.enabled) {
    try {
      webappInstance = startWebAppServer(workflow, config.webapp.port, {
        onInvoiceUpdated: async (invoiceId, cardText, hasPhoto) => {
          await updateTelegramInvoiceCard(bot, workflow, invoiceId, cardText, hasPhoto);
        }
      });
      console.log(`🌐 Telegram Mini App сервер запущен: http://localhost:${config.webapp.port}/webapp`);
      if (config.webapp.url) {
        console.log(`📱 Внешний Mini App URL: ${config.webapp.url}`);
      }
    } catch (err) {
      console.warn('⚠️ Не удалось запустить сервер WebApp:', err);
    }
  }

  console.log('🚀 Запуск Telegram Polling...');
  bot.start({
    onStart: async (botInfo) => {
      console.log(`✨ Бот @${botInfo.username} успешно запущен и готов к приему накладных!`);
      console.log('📸 Отправьте фото накладной в Telegram для проверки.');
      if (config.webapp.url) {
        try {
          await bot.api.setChatMenuButton({
            menu_button: {
              type: 'web_app',
              text: '📱 Накладные',
              web_app: { url: config.webapp.url }
            }
          });
          console.log('📱 Установлена кнопка меню Mini App в Telegram');
        } catch (err) {
          console.warn('⚠️ Не удалось установить MenuButton:', err);
        }
      }
    }
  });

  const stop = async () => {
    console.log('🛑 Остановка бота...');
    bot.stop();
    if (webappInstance) {
      await webappInstance.stop().catch(() => {});
    }
    process.exit(0);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error('Критическая ошибка запуска:', err);
  process.exit(1);
});
