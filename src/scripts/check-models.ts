import { checkConfiguredModels, formatModelReportConsole } from '../gemini/model-checker.js';

async function main() {
  console.log('Запуск проверки моделей Gemini...\n');
  try {
    const report = await checkConfiguredModels({ ping: true });
    console.log(formatModelReportConsole(report));

    const failed = report.configured.filter(c => !c.pingOk);
    if (failed.length > 0) {
      console.warn(`\n⚠️ Предупреждение: ${failed.length} настроенных моделей не прошли проверку доступности.`);
      process.exit(1);
    } else {
      console.log('\n🎉 Все настроенные модели успешно доступны и готовы к работе!');
      process.exit(0);
    }
  } catch (err: any) {
    console.error('Ошибка проверки моделей:', err.message || err);
    process.exit(1);
  }
}

main();
