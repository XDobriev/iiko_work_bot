import { config } from './config.js';
import { getDatabase } from './db/database.js';
import { createBot } from './bot/bot.js';
import { InvoiceWorkflow } from './workflow/invoice-workflow.js';
import { startWebAppServer, WebAppServerInstance } from './webapp/server.js';

async function main() {
  console.log('==============================================');
  console.log('🤖 Запуск iiko Work Bot (TypeScript v2.0)');
  console.log('==============================================');

  // 1. Initialize SQLite Database
  console.log(`📦 Инициализация базы данных: ${config.db.path}`);
  getDatabase();
  console.log('✅ База данных SQLite готова.');

  // 2. Validate Gemini Config
  console.log(`🧠 Gemini модель: ${config.gemini.model}`);
  if (!config.gemini.apiKey) {
    console.warn('⚠️ Внимание: GEMINI_API_KEY не задан в .env!');
  } else {
    console.log('🔑 Gemini API ключ загружен.');
  }

  // 3. iiko status
  if (config.iiko.password) {
    console.log(`🔗 iiko: боевой режим (${config.iiko.url}, логин: ${config.iiko.login})`);
  } else {
    console.log('ℹ️ iiko: безопасный демо-режим (пароль не указан в .env, накладные эмулируются локально)');
  }

  // 4. Initialize Workflow
  const workflow = new InvoiceWorkflow();

  // 5. Start Telegram Mini App Server (if enabled)
  let webappInstance: WebAppServerInstance | null = null;
  if (config.webapp.enabled) {
    try {
      webappInstance = startWebAppServer(workflow, config.webapp.port);
      console.log(`🌐 Telegram Mini App сервер запущен: http://localhost:${config.webapp.port}/webapp`);
      if (config.webapp.url) {
        console.log(`📱 Внешний Mini App URL: ${config.webapp.url}`);
      }
    } catch (err) {
      console.warn('⚠️ Не удалось запустить сервер WebApp:', err);
    }
  }

  // 6. Start Telegram Bot
  if (!config.telegram.token) {
    console.error('❌ ОШИБКА: TELEGRAM_TOKEN не найден в .env!');
    console.log('👉 Пожалуйста, укажите токен в файле .env и перезапустите бота.');
    process.exit(1);
  }

  const bot = createBot(workflow);

  console.log('🚀 Запуск Telegram Polling...');
  bot.start({
    onStart: (botInfo) => {
      console.log(`✨ Бот @${botInfo.username} успешно запущен и готов к приему накладных!`);
      console.log('📸 Отправьте фото накладной в Telegram для проверки.');
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
