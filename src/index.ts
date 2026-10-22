import { config } from './config.js';
import { getDatabase } from './db/database.js';
import { createBot } from './bot/bot.js';

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

  // 4. Start Telegram Bot
  if (!config.telegram.token) {
    console.error('❌ ОШИБКА: TELEGRAM_TOKEN не найден в .env!');
    console.log('👉 Пожалуйста, укажите токен в файле .env и перезапустите бота.');
    process.exit(1);
  }

  const bot = createBot();

  console.log('🚀 Запуск Telegram Polling...');
  bot.start({
    onStart: (botInfo) => {
      console.log(`✨ Бот @${botInfo.username} успешно запущен и готов к приему накладных!`);
      console.log('📸 Отправьте фото накладной в Telegram для проверки.');
    }
  });

  const stop = () => {
    console.log('🛑 Остановка бота...');
    bot.stop();
    process.exit(0);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error('Критическая ошибка запуска:', err);
  process.exit(1);
});
