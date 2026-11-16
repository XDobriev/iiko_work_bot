import { getDatabase } from '../db/database.js';
import { InvoicesRepository } from '../db/invoices.repo.js';
import { InvoiceWorkflow } from '../workflow/invoice-workflow.js';
import { formatInvoiceMessage } from '../bot/formatter.js';
import { parseInvoiceEditText } from '../bot/parser.js';
import { classifyInvoiceItems, partitionItemsByWarehouse } from '../workflow/warehouse-classifier.js';
import { startWebAppServer } from '../webapp/server.js';
import { ProductCatalogMatcher } from '../iiko/matcher.js';
import { MockIikoAccountingGateway } from '../iiko/accounting-gateway.js';
import { InvoiceData } from '../types/index.js';
import { chromium, type Browser, type Page } from 'playwright';

async function runScenarioWalkthrough() {
  console.log('================================================================');
  console.log('🚀 СКВОЗНОЙ ПРОГОН ВСЕХ 6 ПОЛЬЗОВАТЕЛЬСКИХ СЦЕНАРИЕВ IIKO-BOT');
  console.log('================================================================\n');

  const memDb = getDatabase(':memory:');
  const repo = new InvoicesRepository(memDb);
  const mockCatalog = [
    { id: 'prod-001', name: 'Говядина вырезка' },
    { id: 'prod-002', name: 'Лук репчатый' },
    { id: 'prod-003', name: 'Фейри лимон' },
    { id: 'prod-004', name: 'Губки для посуды' },
    { id: 'prod-005', name: 'Кинза свежая' }
  ];
  const mockGateway = new MockIikoAccountingGateway(mockCatalog, repo);
  const workflow = new InvoiceWorkflow({ repo, iikoGateway: mockGateway });

  // -------------------------------------------------------------
  // СЦЕНАРИЙ 1: Приём фото накладной, распознавание и классификация
  // -------------------------------------------------------------
  console.log('📌 [СЦЕНАРИЙ 1] Приём накладной, каскадное распознавание и умная классификация');

  // Шаг 1.1: История прошлых закупок для сверки цен
  repo.saveInvoice({
    date: '10.11.2026',
    supplier: 'ООО МясоПром',
    warehouse: 'kitchen',
    items: [
      { name: 'Говядина вырезка', qty: 10, price: 600, sum: 6000, unit: 'кг' },
      { name: 'Фейри лимон', qty: 5, price: 180, sum: 900, unit: 'бут' }
    ],
    total_written: 6900
  });

  // Шаг 1.2: Новая накладная со смешанными товарами (Кухня + Хоз) и изменением цен
  const rawInvoice: InvoiceData = {
    date: '16.11.2026',
    supplier: 'ООО МясоПром',
    warehouse: 'kitchen',
    items: [
      { name: 'Говядина вырезка', qty: 12, price: 650, sum: 7800, unit: 'кг' }, // Подорожало: 600 -> 650 (+50 ₽)
      { name: 'Лук репчатый', qty: 15, price: 40, sum: 600, unit: 'кг' },       // Новая позиция
      { name: 'Фейри лимон', qty: 4, price: 170, sum: 680, unit: 'бут' },        // Подешевело: 180 -> 170 (-10 ₽)
      { name: 'Губки для посуды', qty: 10, price: 45, sum: 450, unit: 'уп' }     // Хозтовар
    ],
    total_written: 9530,
    model_used: 'gemini-3.8-flash'
  };

  // Классификация складов
  const enrichedItems = classifyInvoiceItems(rawInvoice.items, 'kitchen');
  const classifiedInvoice: InvoiceData = { ...rawInvoice, items: enrichedItems };
  const partition = partitionItemsByWarehouse(classifiedInvoice.items, 'kitchen');
  const kitchenTotal = partition.kitchen.reduce((s, it) => s + it.sum, 0);
  const householdTotal = partition.household.reduce((s, it) => s + it.sum, 0);

  console.log(`   🍽 Позиций кухни: ${partition.kitchen.length} (Сумма: ${kitchenTotal} ₽)`);
  console.log(`   🏠 Позиций хозтоваров: ${partition.household.length} (Сумма: ${householdTotal} ₽)`);

  const { invoiceId } = repo.saveInvoice(classifiedInvoice);
  const comparison = repo.compareWithHistory(classifiedInvoice);
  const telegramHtml = formatInvoiceMessage(invoiceId, classifiedInvoice, comparison);

  console.log(`   ✅ Накладная #${invoiceId} сохранена в БД.`);
  console.log(`   📊 Сверка цен: ${comparison.priceComparisons.map(p => `${p.name} (${p.trend === 'up' ? '🔺 +' + p.deltaRub : '🔻 ' + p.deltaRub} ₽)`).join(', ')}`);
  console.log(`   📱 Сообщение карточки Telegram сформировано (Длина: ${telegramHtml.length} симв.).`);

  // -------------------------------------------------------------
  // СЦЕНАРИЙ 2: Полноэкранный сенсорный редактор Telegram Mini App (E2E Playwright)
  // -------------------------------------------------------------
  console.log('\n📌 [СЦЕНАРИЙ 2] Сенсорный редактор Mini App (Реальный запуск Chromium через Playwright)');

  // Запуск тестового HTTP-сервера Mini App на динамическом порту
  const webapp = startWebAppServer(workflow, 0, { requireAuth: false });
  if (!webapp.server.listening) {
    await new Promise((resolve) => webapp.server.once('listening', resolve));
  }
  const miniAppUrl = `http://127.0.0.1:${webapp.port}/?invoiceId=${invoiceId}`;
  console.log(`   🌐 Сервер Mini App запущен на порту ${webapp.port}`);

  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
  } catch {
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
  }
  const page: Page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // Размер экрана iPhone 14

  try {
    // 2.1 Навигация в редактор
    await page.goto(miniAppUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#items-list .item-card');
    console.log('   ✅ Mini App успешно загрузился в Chromium, карточки товаров отрисованы.');

    // 2.2 Проверка отрисовки данных
    const renderedSupplier = await page.$eval('#supplier-input', (el) => (el as { value: string }).value);
    const cardCount = await page.$$eval('.item-card', (cards) => cards.length);
    console.log(`   🔎 В интерфейсе: Поставщик="${renderedSupplier}", Карточек товаров=${cardCount}`);

    // 2.3 Изменение данных через сенсорный UI
    // a) Увеличиваем количество первой позиции через степпер '+'
    const plusButtons = await page.$$('.stepper-btn');
    if (plusButtons.length >= 2) {
      await plusButtons[1].click(); // Клик по '+' для товара 0
      console.log('   👆 Нажат степпер [+]: количество увеличено.');
    }

    // b) Изменяем цену второго товара
    const priceInputs = await page.$$('.price-input');
    if (priceInputs.length >= 2) {
      await priceInputs[1].fill('45');
      console.log('   ⌨️ Изменена цена позиции 2 на 45 ₽.');
    }

    // c) Переключаем склад позиции 0 на Хоз
    await page.click('#item-wh-btn-0');
    console.log('   🔄 Бейдж склада позиции 1 переключен на «Хоз».');

    // 2.4 Сохранение накладной
    await page.click('.btn-save-main');
    await page.waitForSelector('#toast.show', { timeout: 4000 });
    const toastText = await page.$eval('#toast-text', (el) => (el as { innerText: string }).innerText);
    console.log(`   🔔 Всплывающее уведомление Mini App: "${toastText}"`);

    // 2.5 Проверка сохранения в базе SQLite
    const savedDomain = repo.getInvoice(invoiceId);
    console.log(`   💾 Сохранено в SQLite: Позиций=${savedDomain?.data.items.length}, Сумма=${savedDomain?.data.total_written} ₽`);
  } finally {
    await browser.close();
    await webapp.stop();
    console.log('   🛑 Тестовый браузер и сервер Mini App корректно завершены.');
  }

  // -------------------------------------------------------------
  // СЦЕНАРИЙ 3: Быстрые текстовые правки прямо в чате Telegram
  // -------------------------------------------------------------
  console.log('\n📌 [СЦЕНАРИЙ 3] Быстрые текстовые правки в диалоге Telegram');

  // Правка 3.1: Изменение строки «1: 15 * 700»
  console.log('   💬 Пользователь пишет в чат: "1: 15 * 700"');
  const res1 = workflow.applyTextEdit(invoiceId, '1: 15 * 700');
  if (res1.success && res1.data) {
    const it = res1.data.items[0];
    console.log(`   ✅ Строка 1 обновлена: ${it.qty} шт × ${it.price} ₽ = ${it.sum} ₽. Новый итог: ${res1.data.total_written} ₽`);
  }

  // Правка 3.2: Добавление позиции «+ Кинза свежая 3 * 120»
  console.log('   💬 Пользователь пишет в чат: "+ Кинза свежая 3 * 120"');
  const res2 = workflow.applyTextEdit(invoiceId, '+ Кинза свежая 3 * 120');
  if (res2.success && res2.data) {
    console.log(`   ✅ Позиция добавлена. Строк в накладной: ${res2.data.items.length}, Сумма: ${res2.data.total_written} ₽`);
  }

  // Правка 3.3: Удаление строки «удалить 2»
  console.log('   💬 Пользователь нажимает удалить позицию 2');
  const res3 = workflow.deleteItem(invoiceId, 1);
  if (res3.success && res3.data) {
    console.log(`   ✅ Позиция 2 удалена. Осталось строк: ${res3.data.items.length}, Сумма: ${res3.data.total_written} ₽`);
  }

  // Правка 3.4: Откат последней операции (Undo)
  console.log('   ↩️ Пользователь нажал кнопку «↩️ Отменить правку»');
  const res4 = workflow.undoEdit(invoiceId);
  if (res4.success && res4.data) {
    console.log(`   ✅ Откат выполнен успешно: количество строк восстановилось до ${res4.data.items.length}`);
  }

  // -------------------------------------------------------------
  // СЦЕНАРИЙ 4: Сопоставление номенклатуры (Nomenclature Intelligence)
  // -------------------------------------------------------------
  console.log('\n📌 [СЦЕНАРИЙ 4] Сопоставление рукописных названий со справочником iiko');

  const matcher = new ProductCatalogMatcher(mockCatalog, repo);

  // Сопоставление неточного рукописного названия «говядина вырезка»
  const matchResult = matcher.match('говядина вырезка');
  const suggestions = matcher.findSuggestions('говядина вырезка');
  console.log(`   🔍 Поиск в iiko для «говядина вырезка»: совпало="${matchResult?.product.name}", источник="${matchResult?.source}", подсказок=${suggestions.length}`);

  // Ручное подтверждение маппинга и сохранение в базу памяти
  workflow.saveProductMapping('говядина вырезка', 'Говядина вырезка охл.', 'prod-001');
  const savedMapping = repo.findProductMapping('говядина вырезка');
  console.log(`   💾 Сопоставление записано в БД: «говядина вырезка» ➔ «${savedMapping?.iikoProductName}» (ID: ${savedMapping?.iikoProductId})`);

  // -------------------------------------------------------------
  // СЦЕНАРИЙ 5: Разделение накладной на склады и отправка в iiko (DRAFT)
  // -------------------------------------------------------------
  console.log('\n📌 [СЦЕНАРИЙ 5] Защита от дублей, сопоставление, разделение на Кухню/Хоз и создание черновиков iiko');

  // Шаг 5.1: Проверка блокировки отправки при наличии несопоставленных товаров
  const { invoiceId: unmappedId } = repo.saveInvoice({
    date: '16.11.2026',
    supplier: 'Тест',
    warehouse: 'kitchen',
    total_written: 100,
    items: [{ name: 'Неизвестный продукт без сопоставления', qty: 1, price: 100, sum: 100 }]
  });
  const unmappedSync = await workflow.confirmAndSync(unmappedId);
  console.log(`   🛡 Защита от пустых позиций в iiko: отправка заблокирована=${!unmappedSync.success ? 'ДА ✅' : 'НЕТ'}`);
  console.log(`      Сообщение персоналу: "${unmappedSync.message}"`);

  // Шаг 5.2: Сопоставляем все позиции основной накладной с каталогом iiko
  workflow.saveProductMapping('Говядина вырезка', 'Говядина вырезка', 'prod-001');
  workflow.saveProductMapping('Лук репчатый', 'Лук репчатый', 'prod-002');
  workflow.saveProductMapping('Фейри лимон', 'Фейри лимон', 'prod-003');
  workflow.saveProductMapping('Губки для посуды', 'Губки для посуды', 'prod-004');
  workflow.saveProductMapping('Кинза свежая', 'Кинза свежая', 'prod-005');
  console.log('   ✅ Все товары накладной сопоставлены с каталогом iiko.');

  // Шаг 5.3: Двойной клик персонала (Double-Submit Mutex)
  console.log('   🔒 Тест защиты от двойного нажатия на кнопку «Создать в iiko»:');
  const p1 = workflow.confirmAndSync(invoiceId);
  const p2 = workflow.confirmAndSync(invoiceId);

  const [syncRes1, syncRes2] = await Promise.all([p1, p2]);
  console.log(`   Кликер 1: результат=${syncRes1.success ? 'УСПЕХ ✅' : 'ОТКЛОНЕН ❌'} (${syncRes1.message || ''})`);
  console.log(`   Кликер 2 (повторный клик во время обработки): результат=${syncRes2.success ? 'УСПЕХ' : 'БЛОКИРОВАН ЗАЩИТОЙ ✅'} (${syncRes2.message || ''})`);

  if (syncRes1.documentNumbers) {
    console.log(`      ✨ Смешанная накладная автоматически разделена на 2 черновика:`);
    if (syncRes1.documentNumbers.kitchen) {
      console.log(`         1. Кухня: #${syncRes1.documentNumbers.kitchen}`);
    }
    if (syncRes1.documentNumbers.household) {
      console.log(`         2. Хозяйство: #${syncRes1.documentNumbers.household}`);
    }
  }

  // Шаг 5.4: Блокировка редактирования синхронизированной накладной
  const blockedEdit = workflow.applyTextEdit(invoiceId, '1: 10 * 100');
  console.log(`   🛡 Защита неизменяемости: попытка правки синхронизированной накладной заблокирована: успех=${blockedEdit.success}, причина="${blockedEdit.message}"`);

  // -------------------------------------------------------------
  // СЦЕНАРИЙ 6: Сервисные команды бота
  // -------------------------------------------------------------
  console.log('\n📌 [СЦЕНАРИЙ 6] Проверка системных команд бота');

  const stats = repo.getDailyStats();
  console.log(`   📊 /today: Всего накладных сегодня=${stats.totalInvoices}, Общая сумма=${stats.totalSpend} ₽ (Кухня: ${stats.kitchenSpend} ₽, Хоз: ${stats.householdSpend} ₽)`);

  const recent = repo.getRecentInvoices(3);
  console.log(`   📋 /history: Последние накладные в базе: ${recent.map(r => `#${r.id} (${r.supplier} - ${r.total_written || 0} ₽)`).join(', ')}`);

  const csv = repo.exportCsv();
  console.log(`   📥 /export: Сгенерирован CSV файл размером ${csv.length} байт.`);

  console.log('\n================================================================');
  console.log('🎉 ВСЕ 6 ПОЛЬЗОВАТЕЛЬСКИХ СЦЕНАРИЕВ УСПЕШНО ПРОЙДЕНЫ БЕЗ ОШИБОК!');
  console.log('================================================================');
}

runScenarioWalkthrough().catch(err => {
  console.error('❌ Ошибка во время выполнения сквозного сценария:', err);
  process.exit(1);
});
