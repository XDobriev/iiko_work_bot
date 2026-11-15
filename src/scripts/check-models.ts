import { GeminiAutopilot, formatAutopilotReportConsole } from '../gemini/autopilot.js';

async function main() {
  console.log('Запуск динамического автопилота Gemini...\n');
  try {
    const autopilot = GeminiAutopilot.getInstance();
    const plan = await autopilot.refresh(true);

    console.log(formatAutopilotReportConsole(plan));

    if (plan.fromFallback) {
      console.warn('\n⚠️ Предупреждение: Автопилот перешел в резервный режим (.env). Ни одна живая модель из Google API не ответила успешно.');
      process.exit(1);
    } else {
      console.log(`\n🎉 Автопилот успешно настроен! Выбрано моделей: ${plan.models.length}.`);
      console.log(`   📸 Основная фото:     ${plan.photoModels[0]}`);
      console.log(`   🎙 Основная аудио:    ${plan.voiceModels[0]}`);
      console.log(`   ⚡️ Основная эскалация: ${plan.complexModels[0]}`);
      process.exit(0);
    }
  } catch (err: any) {
    console.error('Ошибка запуска автопилота:', err.message || err);
    process.exit(1);
  }
}

main();
