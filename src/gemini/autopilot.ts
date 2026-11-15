import { config } from '../config.js';
import { escapeHtml } from '../bot/formatter.js';
import {
  fetchGoogleModels,
  pingModel,
  GoogleModelInfo,
  isEligibleGeminiModel,
  parseGenerationNumber,
  detectReasoningCapability,
  detectAudioCapability
} from './model-checker.js';

export {
  isEligibleGeminiModel,
  parseGenerationNumber,
  detectReasoningCapability,
  detectAudioCapability
};

export type AutopilotRole = 'photo' | 'voice' | 'complex' | 'general';

export type ModelTier = 'reasoning' | 'fast-vision' | 'audio' | 'fallback' | 'rejected';

export interface BenchmarkedModel {
  name: string;
  displayName: string;
  ok: boolean;
  latencyMs?: number;
  error?: string;
  hasReasoning: boolean;
  isAudioSpecialized: boolean;
  generation: number;
  tier: ModelTier;
  rejectionReason?: string;
}

export interface AutopilotPlan {
  photoModels: string[];
  voiceModels: string[];
  complexModels: string[];
  generalModels: string[];
  reasoningModel?: string;
  audioModel?: string;
  benchmarkedAt: string;
  expiresAt: string;
  models: BenchmarkedModel[];
  rejectedModels: BenchmarkedModel[];
  fromFallback: boolean;
}

/**
 * Ranks benchmarked models into an optimal AutopilotPlan.
 */
export function rankModels(
  benchmarked: BenchmarkedModel[],
  fallbackConfig = config.gemini,
  ttlMs = 30 * 60 * 1000
): AutopilotPlan {
  const timestamp = new Date();
  const passed = benchmarked.filter(b => b.ok);
  const rejected = benchmarked.filter(b => !b.ok);

  // If no models survived live benchmark, fallback safely to .env with short recovery TTL (60s)
  if (passed.length === 0) {
    const fallbackTtlMs = 60 * 1000; // 1 min TTL for quick recovery from network blips
    const fallbackExpiresAt = new Date(timestamp.getTime() + fallbackTtlMs);
    return {
      photoModels: [...fallbackConfig.photoModels],
      voiceModels: [...fallbackConfig.voiceModels],
      complexModels: [...fallbackConfig.complexModels],
      generalModels: [...fallbackConfig.models],
      benchmarkedAt: timestamp.toISOString(),
      expiresAt: fallbackExpiresAt.toISOString(),
      models: [],
      rejectedModels: rejected,
      fromFallback: true
    };
  }

  const expiresAt = new Date(timestamp.getTime() + ttlMs);

  // Categorize models
  const reasoningModels = passed
    .filter(m => m.hasReasoning)
    .sort((a, b) => {
      if (b.generation !== a.generation) return b.generation - a.generation;
      return (a.latencyMs || 0) - (b.latencyMs || 0);
    });

  const audioModels = passed
    .filter(m => m.isAudioSpecialized)
    .sort((a, b) => {
      if (b.generation !== a.generation) return b.generation - a.generation;
      return (a.latencyMs || 0) - (b.latencyMs || 0);
    });

  // Fast Vision & Multimodal models (not audio-only)
  const visionModels = passed
    .filter(m => !m.isAudioSpecialized)
    .sort((a, b) => {
      // 1. Generation desc
      if (b.generation !== a.generation) return b.generation - a.generation;
      // 2. Flash before Pro for speed
      const aIsFlash = a.name.includes('flash') ? 1 : 0;
      const bIsFlash = b.name.includes('flash') ? 1 : 0;
      if (bIsFlash !== aIsFlash) return bIsFlash - aIsFlash;
      // 3. Latency asc
      return (a.latencyMs || 0) - (b.latencyMs || 0);
    });

  // Fast low-latency models for general edits & voice reserve (not audio, not reasoning)
  const fastModels = passed
    .filter(m => !m.isAudioSpecialized && !m.hasReasoning)
    .sort((a, b) => {
      if (b.generation !== a.generation) return b.generation - a.generation;
      const aIsFlash = a.name.includes('flash') ? 1 : 0;
      const bIsFlash = b.name.includes('flash') ? 1 : 0;
      if (bIsFlash !== aIsFlash) return bIsFlash - aIsFlash;
      return (a.latencyMs || 0) - (b.latencyMs || 0);
    });
  const fallbackFastList = fastModels.length > 0 ? fastModels : visionModels;

  // Role assignments:
  // Photo (Receipt recognition):
  // 1. Reasoning models get absolute highest priority (handles math, handwritten 1/7, dirty receipts).
  // 2. Stable vision models stand in reserve.
  const photoCandidates: string[] = [];
  for (const rm of reasoningModels) {
    if (!photoCandidates.includes(rm.name)) photoCandidates.push(rm.name);
  }
  for (const vm of visionModels) {
    if (!photoCandidates.includes(vm.name)) photoCandidates.push(vm.name);
  }

  // Complex (Cascade escalation for sum discrepancies):
  // Reasoning models are ideal for recalculating totals, followed by top vision models.
  const complexCandidates: string[] = [];
  for (const rm of reasoningModels) {
    if (!complexCandidates.includes(rm.name)) complexCandidates.push(rm.name);
  }
  for (const vm of visionModels) {
    if (!complexCandidates.includes(vm.name)) complexCandidates.push(vm.name);
  }

  // Voice (Audio dictation):
  // 1. Audio-specialized transcribe models.
  // 2. Fast low-latency models in reserve.
  const voiceCandidates: string[] = [];
  for (const am of audioModels) {
    if (!voiceCandidates.includes(am.name)) voiceCandidates.push(am.name);
  }
  for (const fm of fallbackFastList) {
    if (!voiceCandidates.includes(fm.name)) voiceCandidates.push(fm.name);
  }

  // General (free-text edits):
  // Fast low-latency models first.
  const generalCandidates: string[] = [];
  for (const fm of fallbackFastList) {
    if (!generalCandidates.includes(fm.name)) generalCandidates.push(fm.name);
  }
  for (const vm of visionModels) {
    if (!generalCandidates.includes(vm.name)) generalCandidates.push(vm.name);
  }
  if (generalCandidates.length === 0 && passed.length > 0) {
    generalCandidates.push(passed[0].name);
  }

  return {
    photoModels: photoCandidates.slice(0, 4),
    voiceModels: voiceCandidates.slice(0, 4),
    complexModels: complexCandidates.slice(0, 3),
    generalModels: generalCandidates.slice(0, 3),
    reasoningModel: reasoningModels[0]?.name,
    audioModel: audioModels[0]?.name,
    benchmarkedAt: timestamp.toISOString(),
    expiresAt: expiresAt.toISOString(),
    models: passed,
    rejectedModels: rejected,
    fromFallback: false
  };
}

/**
 * Executes async task with concurrency limit.
 */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let currentIndex = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (currentIndex < items.length) {
      const index = currentIndex++;
      results[index] = await fn(items[index]);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Autopilot engine for Gemini models.
 */
export class GeminiAutopilot {
  private static instance: GeminiAutopilot;
  private currentPlan: AutopilotPlan | null = null;
  private refreshPromise: Promise<AutopilotPlan> | null = null;
  private apiKey: string;
  private ttlMs: number;

  constructor(apiKey?: string, ttlMs = 30 * 60 * 1000) {
    this.apiKey = apiKey || config.gemini.apiKey;
    this.ttlMs = ttlMs;
  }

  public static getInstance(apiKey?: string, ttlMs?: number): GeminiAutopilot {
    if (!GeminiAutopilot.instance) {
      GeminiAutopilot.instance = new GeminiAutopilot(apiKey, ttlMs);
    } else {
      if (apiKey && GeminiAutopilot.instance.apiKey !== apiKey) {
        GeminiAutopilot.instance.apiKey = apiKey;
      }
      if (ttlMs !== undefined) {
        GeminiAutopilot.instance.ttlMs = ttlMs;
      }
    }
    return GeminiAutopilot.instance;
  }

  public static resetInstance(): void {
    GeminiAutopilot.instance = undefined as any;
  }

  public getPlan(): AutopilotPlan {
    if (this.currentPlan && new Date(this.currentPlan.expiresAt).getTime() > Date.now()) {
      return this.currentPlan;
    }

    if (!this.currentPlan) {
      // Synchronous initial fallback plan while refresh runs or before first start
      const now = new Date();
      return {
        photoModels: [...config.gemini.photoModels],
        voiceModels: [...config.gemini.voiceModels],
        complexModels: [...config.gemini.complexModels],
        generalModels: [...config.gemini.models],
        benchmarkedAt: now.toISOString(),
        expiresAt: now.toISOString(),
        models: [],
        rejectedModels: [],
        fromFallback: true
      };
    }

    return this.currentPlan;
  }

  public getActiveModels(role: AutopilotRole = 'general'): string[] {
    const plan = this.getPlan();
    if (role === 'photo') return plan.photoModels;
    if (role === 'voice') return plan.voiceModels;
    if (role === 'complex') return plan.complexModels;
    return plan.generalModels;
  }

  /**
   * Refreshes model discovery and benchmark. Thread-safe with singleton promise caching.
   */
  public async refresh(force = false): Promise<AutopilotPlan> {
    if (
      !force &&
      this.currentPlan &&
      new Date(this.currentPlan.expiresAt).getTime() > Date.now()
    ) {
      return this.currentPlan;
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.executeRefresh().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  private async executeRefresh(): Promise<AutopilotPlan> {
    const key = this.apiKey || config.gemini.apiKey;
    if (!key) {
      console.warn('[Autopilot] GEMINI_API_KEY не задан, используется резервная конфигурация.');
      this.currentPlan = rankModels([], config.gemini, this.ttlMs);
      return this.currentPlan;
    }

    console.log('[Autopilot] 🚀 Запуск динамического автопилота Gemini...');
    try {
      let rawModels: GoogleModelInfo[] = [];
      try {
        rawModels = await fetchGoogleModels(key);
      } catch (err: any) {
        console.warn(`[Autopilot] Не удалось запросить список моделей Google API (${err.message}). Используется fallback.`);
        this.currentPlan = rankModels([], config.gemini, this.ttlMs);
        return this.currentPlan;
      }

      // 1. Smart filtering of eligible models
      const eligibleModels: GoogleModelInfo[] = [];
      const preFilteredRejected: BenchmarkedModel[] = [];

      for (const m of rawModels) {
        const eligibility = isEligibleGeminiModel(m);
        if (eligibility.eligible) {
          eligibleModels.push(m);
        } else if (m.name.toLowerCase().includes('gemini')) {
          preFilteredRejected.push({
            name: m.name,
            displayName: m.displayName || m.name,
            ok: false,
            generation: parseGenerationNumber(m.name),
            tier: 'rejected',
            hasReasoning: false,
            isAudioSpecialized: false,
            rejectionReason: eligibility.reason || 'Исключена из-за нецелевого назначения'
          });
        }
      }

      console.log(`[Autopilot] Обнаружено ${rawModels.length} моделей в Google API. Отобрано кандидатов: ${eligibleModels.length}.`);

      // Sort candidates so newest generations (4.x, 3.x) and transcribe are tested first
      eligibleModels.sort((a, b) => {
        const genA = parseGenerationNumber(a.name);
        const genB = parseGenerationNumber(b.name);
        return genB - genA;
      });

      // 2. Automated benchmark with concurrency 4
      const benchmarkResults = await mapConcurrent(eligibleModels, 4, async m => {
        const ping = await pingModel(m.name, key);
        const generation = parseGenerationNumber(m.name);
        const hasReasoning = detectReasoningCapability(m, ping);
        const isAudio = detectAudioCapability(m);

        let tier: ModelTier = 'fast-vision';
        let rejectionReason: string | undefined = undefined;

        if (!ping.ok) {
          tier = 'rejected';
          const errLower = (ping.error || '').toLowerCase();
          if (errLower.includes('404')) {
            rejectionReason = '404 Модель недоступна/снята';
          } else if (errLower.includes('429')) {
            rejectionReason = '429 Превышена квота (Quota exceeded)';
          } else if (errLower.includes('503') || errLower.includes('500')) {
            rejectionReason = '503 Временная перегрузка сервиса';
          } else if (
            errLower.includes('timeout') ||
            errLower.includes('abort') ||
            (ping.latencyMs || 0) >= 15000
          ) {
            rejectionReason = 'Таймаут отклика (>15с)';
          } else {
            rejectionReason = ping.error || 'Ошибка отклика';
          }
        } else if (isAudio) {
          tier = 'audio';
        } else if (hasReasoning) {
          tier = 'reasoning';
        } else {
          tier = 'fast-vision';
        }

        const res: BenchmarkedModel = {
          name: m.name,
          displayName: m.displayName || m.name,
          ok: ping.ok,
          latencyMs: ping.latencyMs,
          error: ping.error,
          hasReasoning,
          isAudioSpecialized: isAudio,
          generation,
          tier,
          rejectionReason
        };

        return res;
      });

      const allBenchmarked = [...benchmarkResults, ...preFilteredRejected];
      this.currentPlan = rankModels(allBenchmarked, config.gemini, this.ttlMs);

      console.log(`[Autopilot] ✅ Бенчмарк завершен. Активные модели:`);
      console.log(`  📸 Фото: ${this.currentPlan.photoModels.join(' -> ')}`);
      console.log(`  🎙 Голос: ${this.currentPlan.voiceModels.join(' -> ')}`);
      console.log(`  ⚡️ Эскалация: ${this.currentPlan.complexModels.join(' -> ')}`);

      return this.currentPlan;
    } catch (err: any) {
      console.warn(`[Autopilot] Непредвиденная ошибка автопилота (${err.message}). Используется fallback.`);
      this.currentPlan = rankModels([], config.gemini, this.ttlMs);
      return this.currentPlan;
    }
  }
}

/**
 * Formats an Autopilot report for Telegram HTML messages.
 */
export function formatAutopilotReportHtml(plan: AutopilotPlan): string {
  const lines: string[] = [
    '🚀 <b>Gemini Автопилот — Статус моделей</b>',
    `🕒 Проверено: <code>${new Date(plan.benchmarkedAt).toLocaleTimeString('ru-RU')}</code>${plan.fromFallback ? ' <i>(Резервный режим .env)</i>' : ' <i>(Google API Live)</i>'}`,
    ''
  ];

  // Active models
  lines.push('<b>🎯 Активные модели автопилота:</b>');

  const photoMain = plan.photoModels[0] || 'нет';
  const photoReserve = plan.photoModels.slice(1).join(', ') || 'нет';
  const photoMeta = plan.models.find(m => m.name === photoMain);
  const photoBadge = photoMeta?.hasReasoning ? '🧠 Reasoning' : '⚡️ Vision';
  const photoLat = photoMeta?.latencyMs ? ` (<code>${photoMeta.latencyMs} мс</code>)` : '';

  lines.push(`📸 <b>Фото (чеки):</b> <code>${escapeHtml(photoMain)}</code> [${photoBadge}]${photoLat}`);
  if (photoReserve !== 'нет') {
    lines.push(`   <i>Резерв:</i> <code>${escapeHtml(photoReserve)}</code>`);
  }

  const voiceMain = plan.voiceModels[0] || 'нет';
  const voiceReserve = plan.voiceModels.slice(1).join(', ') || 'нет';
  const voiceMeta = plan.models.find(m => m.name === voiceMain);
  const voiceBadge = voiceMeta?.isAudioSpecialized ? '🎙 Audio-STT' : '⚡️ Multimodal';
  const voiceLat = voiceMeta?.latencyMs ? ` (<code>${voiceMeta.latencyMs} мс</code>)` : '';

  lines.push(`🎙 <b>Голос (аудио):</b> <code>${escapeHtml(voiceMain)}</code> [${voiceBadge}]${voiceLat}`);
  if (voiceReserve !== 'нет') {
    lines.push(`   <i>Резерв:</i> <code>${escapeHtml(voiceReserve)}</code>`);
  }

  const complexMain = plan.complexModels[0] || 'нет';
  const complexReserve = plan.complexModels.slice(1).join(', ') || 'нет';
  const complexMeta = plan.models.find(m => m.name === complexMain);
  const complexBadge = complexMeta?.hasReasoning ? '🧠 Deep Math Reasoning' : '⚡️ Vision Escalation';
  const complexLat = complexMeta?.latencyMs ? ` (<code>${complexMeta.latencyMs} мс</code>)` : '';

  lines.push(`⚡️ <b>Эскалация (расхождения):</b> <code>${escapeHtml(complexMain)}</code> [${complexBadge}]${complexLat}`);
  if (complexReserve !== 'нет') {
    lines.push(`   <i>Резерв:</i> <code>${escapeHtml(complexReserve)}</code>`);
  }

  lines.push('');

  // Operational models table
  if (plan.models.length > 0) {
    lines.push('<b>✅ Доступные проверенные модели:</b>');
    for (const m of plan.models) {
      let tag = '⚡️ Vision';
      if (m.hasReasoning) tag = '🧠 Reasoning';
      else if (m.isAudioSpecialized) tag = '🎙 Audio';

      lines.push(`  • <code>${escapeHtml(m.name)}</code> — ${tag} (<code>${m.latencyMs ?? '?'} мс</code>)`);
    }
    lines.push('');
  }

  // Filtered / Rejected models
  const criticalRejections = plan.rejectedModels.filter(r =>
    r.rejectionReason?.includes('429') ||
    r.rejectionReason?.includes('503') ||
    r.rejectionReason?.includes('Таймаут') ||
    r.rejectionReason?.includes('404')
  );

  if (criticalRejections.length > 0) {
    lines.push('<b>⚠️ Отсеяны бенчмарком (недоступны):</b>');
    for (const r of criticalRejections.slice(0, 5)) {
      lines.push(`  ❌ <code>${escapeHtml(r.name)}</code> — <i>${escapeHtml(r.rejectionReason || 'ошибка')}</i>`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Formats an Autopilot report for CLI console output.
 */
export function formatAutopilotReportConsole(plan: AutopilotPlan): string {
  const lines: string[] = [];
  lines.push('========================================================================');
  lines.push('🤖 РЕЗУЛЬТАТЫ РАБОТЫ АВТОПИЛОТА GEMINI (DYNAMIC AUTOPILOT)');
  lines.push('========================================================================\n');
  lines.push(`Время бенчмарка: ${plan.benchmarkedAt}`);
  lines.push(`Режим работы: ${plan.fromFallback ? '⚠️ РЕЗЕРВНЫЙ (.env)' : '🚀 LIVE GOOGLE API'}\n`);

  lines.push('--- НАЗНАЧЕННЫЕ РОЛИ АВТОПИЛОТА ---');
  lines.push(`  📸 Фото (накладные):       ${plan.photoModels.join(' -> ')}`);
  lines.push(`  🎙 Голос (аудиозаказы):     ${plan.voiceModels.join(' -> ')}`);
  lines.push(`  ⚡️ Каскадная эскалация:   ${plan.complexModels.join(' -> ')}`);
  lines.push(`  ⚙️ Общие правки:           ${plan.generalModels.join(' -> ')}\n`);

  if (plan.models.length > 0) {
    lines.push('--- ПРОВЕРЕННЫЕ ДОСТУПНЫЕ МОДЕЛИ ---');
    for (const m of plan.models) {
      const type = m.hasReasoning ? '[REASONING]' : m.isAudioSpecialized ? '[AUDIO]' : '[VISION]';
      const lat = m.latencyMs !== undefined ? `${m.latencyMs}ms` : 'n/a';
      lines.push(`  ✅ ${m.name.padEnd(28)} ${type.padEnd(12)} ${lat.padEnd(8)} (Gen ${m.generation.toFixed(1)})`);
    }
    lines.push('');
  }

  if (plan.rejectedModels.length > 0) {
    lines.push('--- ОТСЕЯННЫЕ / НЕРАБОТАЮЩИЕ МОДЕЛИ ---');
    for (const r of plan.rejectedModels) {
      lines.push(`  ❌ ${r.name.padEnd(28)} [${r.rejectionReason || 'отклонена'}]`);
    }
    lines.push('');
  }

  lines.push('========================================================================');
  return lines.join('\n');
}
