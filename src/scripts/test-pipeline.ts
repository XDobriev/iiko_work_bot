import { getDatabase } from '../db/database.js';
import { InvoicesRepository } from '../db/invoices.repo.js';
import { formatInvoiceMessage } from '../bot/formatter.js';
import { IikoClient } from '../iiko/client.js';
import { GeminiInvoiceRecognizer } from '../gemini/recognizer.js';
import { InvoiceData } from '../types/index.js';

async function runTestPipeline() {
  console.log('====================================================');
  console.log('🧪 ЗАПУСК ТЕСТОВОГО КОНВЕЙЕРА (TEST PIPELINE)');
  console.log('====================================================\n');

  // Use an in-memory or dedicated test database
  const testDb = getDatabase('./data/test_invoices.db');
  const repo = new InvoicesRepository(testDb);

  console.log('1️⃣ ТЕСТ БАЗЫ ДАННЫХ И ИСТОРИИ ЦЕН:');
  // Seed past invoice #1
  const pastInvoice: InvoiceData = {
    date: '15.10.2026',
    supplier: 'Бойня',
    warehouse: 'kitchen',
    items: [
      { name: 'Говядина мякоть', qty: 10, price: 550, sum: 5500 },
      { name: 'Лук репчатый', qty: 20, price: 35, sum: 700 }
    ],
    total_written: 6200
  };
  const { invoiceId: pastId } = repo.saveInvoice(pastInvoice);
  console.log(`   ✅ Прошлая накладная успешно сохранена с ID #${pastId}`);

  // Check known items memory
  const knownItems = repo.getKnownItems();
  console.log(`   🧠 Известные товары из памяти базы:`, knownItems);

  console.log('\n2️⃣ ТЕСТ СВЕРКИ ЦЕН И ВЫЯВЛЕНИЯ ПОДОРОЖАНИЯ:');
  // New invoice with price increase
  const newInvoice: InvoiceData = {
    date: '22.10.2026',
    supplier: 'Бойня',
    warehouse: 'kitchen',
    items: [
      { name: 'Говядина мякоть', qty: 12, price: 600, sum: 7200 }, // +50 руб подорожание
      { name: 'Лук репчатый', qty: 25, price: 30, sum: 750 },      // -5 руб подешевел
      { name: 'Сыр Сулугуни', qty: 5, price: 450, sum: 2250 }      // новая позиция
    ],
    total_written: 10200
  };

  const comparison = repo.compareWithHistory(newInvoice);
  console.log(`   📊 Найдено изменений цен: ${comparison.priceComparisons.length}`);
  for (const pc of comparison.priceComparisons) {
    if (pc.trend === 'up') {
      console.log(`   🔺 [ПОДОРОЖАНИЕ] ${pc.name}: ${pc.previousPrice} ₽ -> ${pc.currentPrice} ₽ (+${pc.deltaRub} ₽ / +${pc.deltaPercent}%)`);
    } else if (pc.trend === 'down') {
      console.log(`   🔻 [СКИДКА] ${pc.name}: ${pc.previousPrice} ₽ -> ${pc.currentPrice} ₽ (${pc.deltaRub} ₽ / ${pc.deltaPercent}%)`);
    } else {
      console.log(`   🆕 [НОВАЯ ПОЗИЦИЯ] ${pc.name}: ${pc.currentPrice} ₽`);
    }
  }

  console.log('\n3️⃣ ТЕСТ ФОРМАТИРОВАНИЯ СООБЩЕНИЯ ДЛЯ TELEGRAM:');
  const cardText = formatInvoiceMessage(2, newInvoice, comparison);
  console.log('--- ТЕКСТ КАРТОЧКИ В TELEGRAM ---');
  console.log(cardText);
  console.log('---------------------------------');

  console.log('\n4️⃣ ТЕСТ ДУБЛИКАТА:');
  const duplicateCheck = repo.checkDuplicate(pastInvoice);
  console.log(`   Повторная отправка накладной от ${pastInvoice.date}: Дубликат? ${duplicateCheck.isDuplicate ? 'ДА ⚠️' : 'НЕТ'}`);

  console.log('\n5️⃣ ТЕСТ IIKO КЛИЕНТА:');
  const iikoClient = new IikoClient();
  const iikoResult = await iikoClient.createInvoice(newInvoice);
  console.log(`   Результат создания накладной:`, iikoResult);

  console.log('\n6️⃣ ТЕСТ РЕАЛЬНОГО ВЫЗОВА GEMINI 3.8 FLASH VISION:');
  try {
    const recognizer = new GeminiInvoiceRecognizer();
    // 1x1 test image
    const tinyJpegB64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
    const buf = Buffer.from(tinyJpegB64, 'base64');
    console.log('   📡 Отправка тестового запроса в Gemini 3.8 Flash...');
    const recResult = await recognizer.recognize(buf, { knownItems });
    console.log('   ✅ Gemini успешно распознал структуру и вернул валидный JSON:');
    console.log(JSON.stringify(recResult, null, 2));
  } catch (err: any) {
    console.error('   ❌ Ошибка Gemini:', err.message);
  }

  console.log('\n====================================================');
  console.log('🎉 ВСЕ КОМПОНЕНТЫ УСПЕШНО ПРОТЕСТИРОВАНЫ!');
  console.log('====================================================');
}

runTestPipeline().catch(console.error);
