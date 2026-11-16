import { config } from '../config.js';
import { escapeHtml } from '../bot/formatter.js';

export interface GoogleModelInfo {
  name: string; // e.g. "gemini-2.5-flash"
  rawName: string; // e.g. "models/gemini-2.5-flash"
  displayName: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods: string[];
}

export type ModelRole = 'photo' | 'voice' | 'complex' | 'general';
export type AutopilotRole = ModelRole;
export type ModelTier = 'reasoning' | 'fast-vision' | 'audio' | 'fallback' | 'rejected';

export interface ModelCheckItem {
  model: string;
  role: ModelRole;
  inGoogleList: boolean;
  pingOk: boolean;
  latencyMs?: number;
  error?: string;
  displayName?: string;
}

export interface ModelCheckReport {
  timestamp: string;
  totalGoogleModels: number;
  configured: ModelCheckItem[];
  recommendations: string[];
  allGeminiModels: string[];
}

export interface PingResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
  hasReasoning?: boolean;
  thoughtsTokenCount?: number;
}

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
 * Fetches models from Google Generative Language API.
 */
export async function fetchGoogleModels(apiKey?: string): Promise<GoogleModelInfo[]> {
  const key = apiKey || config.gemini.apiKey;
  if (!key) {
    throw new Error('GEMINI_API_KEY не задан в конфигурации.');
  }

  const url = 'https://generativelanguage.googleapis.com/v1beta/models';
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'x-goog-api-key': key
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Google Models API error (${response.status}): ${errText.slice(0, 150)}`);
  }

  const data = (await response.json()) as { models?: any[] };
  if (!data.models || !Array.isArray(data.models)) {
    return [];
  }

  return data.models
    .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
    .map(m => {
      const rawName = String(m.name || '');
      const name = rawName.replace(/^models\//, '');
      return {
        name,
        rawName,
        displayName: m.displayName || name,
        description: m.description,
        inputTokenLimit: m.inputTokenLimit,
        outputTokenLimit: m.outputTokenLimit,
        supportedGenerationMethods: m.supportedGenerationMethods || []
      };
    });
}

/**
 * Sends a lightweight prompt to verify model accessibility and measure response latency.
 */
export async function pingModel(
  model: string,
  apiKey?: string,
  timeoutMs: number = config.gemini.pingTimeoutMs || 35000
): Promise<PingResult> {
  const key = apiKey || config.gemini.apiKey;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const start = Date.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: '1+1=' }] }],
        generationConfig: { maxOutputTokens: 5, temperature: 0 }
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });

    const latencyMs = Date.now() - start;
    if (!response.ok) {
      const errText = await response.text();
      return { ok: false, latencyMs, error: `HTTP ${response.status}: ${errText.slice(0, 80)}` };
    }

    let thoughtsTokenCount: number | undefined;
    let hasReasoning = false;
    try {
      const json = (await response.json()) as any;
      thoughtsTokenCount = json.usageMetadata?.thoughtsTokenCount;
      const candidateParts = json.candidates?.[0]?.content?.parts || [];
      const hasExplicitThoughtPart = candidateParts.some((p: any) => p.thought === true);
      hasReasoning = Boolean((typeof thoughtsTokenCount === 'number' && thoughtsTokenCount > 0) || hasExplicitThoughtPart);
    } catch {
      // ignore json parse error in ping
    }

    return { ok: true, latencyMs, hasReasoning, thoughtsTokenCount };
  } catch (err: any) {
    return { ok: false, latencyMs: Date.now() - start, error: err.message || String(err) };
  }
}

/**
 * Parses numeric generation from model identifier.
 */
export function parseGenerationNumber(modelName: string): number {
  const clean = modelName.toLowerCase();
  const match = clean.match(/gemini-(\d+(?:\.\d+)?)/);
  if (match) {
    const num = parseFloat(match[1]);
    if (!isNaN(num)) return num;
  }
  if (clean.includes('latest')) return 3.0;
  return 2.0;
}

/**
 * Determines whether a model is an eligible text/vision/audio candidate for Gemini Autopilot.
 */
export function isEligibleGeminiModel(m: GoogleModelInfo): { eligible: boolean; reason?: string } {
  const name = m.name.toLowerCase();
  const desc = (m.description || '').toLowerCase();
  const disp = (m.displayName || '').toLowerCase();

  // 1. Must support generateContent
  if (!m.supportedGenerationMethods || !m.supportedGenerationMethods.includes('generateContent')) {
    return { eligible: false, reason: 'Не поддерживает метод generateContent' };
  }

  // 2. Must belong to the Gemini family
  if (!name.startsWith('gemini') && !name.includes('gemini')) {
    return { eligible: false, reason: 'Не принадлежит семейству Gemini' };
  }

  // 3. Exclude pure speech synthesis (TTS)
  if (name.includes('-tts') || desc.includes('preview tts') || disp.includes('tts')) {
    return { eligible: false, reason: 'Служебная модель синтеза речи (TTS)' };
  }

  // 4. Exclude embeddings
  if (name.includes('embedding') || desc.includes('embedding')) {
    return { eligible: false, reason: 'Модель векторных эмбеддингов' };
  }

  // 5. Exclude robotics
  if (name.includes('robotics') || desc.includes('robotics')) {
    return { eligible: false, reason: 'Служебная модель robotics' };
  }

  // 6. Exclude pure image generation
  if (
    name.includes('-image') ||
    name.includes('image-preview') ||
    name.includes('nano-banana') ||
    disp.includes('banana')
  ) {
    return { eligible: false, reason: 'Модель генерации изображений' };
  }

  // 7. Exclude computer-use / desktop automation
  if (name.includes('computer-use') || desc.includes('computer use')) {
    return { eligible: false, reason: 'Специализированная модель Computer Use' };
  }

  // 8. Exclude custom tools preview
  if (name.includes('customtools')) {
    return { eligible: false, reason: 'Специализированная preview-модель custom tools' };
  }

  return { eligible: true };
}

/**
 * Detects whether model supports deep reasoning / thinking.
 */
export function detectReasoningCapability(
  m: GoogleModelInfo,
  pingResult?: { hasReasoning?: boolean; thoughtsTokenCount?: number }
): boolean {
  if (
    pingResult?.hasReasoning === true ||
    (typeof pingResult?.thoughtsTokenCount === 'number' && pingResult.thoughtsTokenCount > 0)
  ) {
    return true;
  }

  const name = m.name.toLowerCase();
  const desc = (m.description || '').toLowerCase();
  const disp = (m.displayName || '').toLowerCase();

  const keywords = ['hydrogen', 'thinking', 'reasoning', 'thought', 'deep-think'];
  return keywords.some(k => name.includes(k) || desc.includes(k) || disp.includes(k));
}

/**
 * Detects whether model has audio/speech transcription specialization.
 */
export function detectAudioCapability(m: GoogleModelInfo): boolean {
  const name = m.name.toLowerCase();
  const desc = (m.description || '').toLowerCase();
  const disp = (m.displayName || '').toLowerCase();

  const keywords = ['transcribe', 'speech', 'audio', 'whisper', 'stt'];
  return keywords.some(k => name.includes(k) || desc.includes(k) || disp.includes(k));
}

/**
 * Checks all configured models against live Google API.
 */
export async function checkConfiguredModels(options?: {
  apiKey?: string;
  ping?: boolean;
}): Promise<ModelCheckReport> {
  const key = options?.apiKey || config.gemini.apiKey;
  const shouldPing = options?.ping !== false;

  let googleModels: GoogleModelInfo[] = [];
  try {
    googleModels = await fetchGoogleModels(key);
  } catch (err) {
    console.warn('[ModelChecker] Не удалось получить список моделей из Google API:', err);
  }

  const googleModelNames = new Set(googleModels.map(m => m.name.toLowerCase()));
  const allGeminiModels = googleModels
    .map(m => m.name)
    .filter(name => name.includes('gemini'));

  const configuredItems: Array<{ model: string; role: ModelRole }> = [
    ...config.gemini.photoModels.map(m => ({ model: m, role: 'photo' as ModelRole })),
    ...config.gemini.voiceModels.map(m => ({ model: m, role: 'voice' as ModelRole })),
    ...config.gemini.complexModels.map(m => ({ model: m, role: 'complex' as ModelRole }))
  ];

  const pingResults = new Map<string, { ok: boolean; latencyMs?: number; error?: string }>();

  if (shouldPing && key) {
    const uniqueModels = [...new Set(configuredItems.map(i => i.model))];
    for (const m of uniqueModels) {
      const res = await pingModel(m, key);
      pingResults.set(m, res);
    }
  }

  const configured: ModelCheckItem[] = configuredItems.map(item => {
    const inGoogle = googleModelNames.has(item.model.toLowerCase());
    const gInfo = googleModels.find(m => m.name.toLowerCase() === item.model.toLowerCase());
    const ping = pingResults.get(item.model);

    return {
      model: item.model,
      role: item.role,
      inGoogleList: inGoogle,
      pingOk: ping ? ping.ok : inGoogle,
      latencyMs: ping?.latencyMs,
      error: ping?.error,
      displayName: gInfo?.displayName
    };
  });

  const configuredSet = new Set(configured.map(c => c.model.toLowerCase()));
  const recommendations: string[] = [];

  const eligibleCandidates = googleModels
    .filter(m => isEligibleGeminiModel(m).eligible && !configuredSet.has(m.name.toLowerCase()))
    .map(m => m.name);

  for (const rec of eligibleCandidates) {
    if (shouldPing && key) {
      let ping = pingResults.get(rec);
      if (!ping) {
        ping = await pingModel(rec, key);
        pingResults.set(rec, ping);
      }
      if (ping.ok) {
        recommendations.push(rec);
      }
    } else {
      recommendations.push(rec);
    }
  }

  return {
    timestamp: new Date().toISOString(),
    totalGoogleModels: googleModels.length,
    configured,
    recommendations,
    allGeminiModels
  };
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

  if (passed.length === 0) {
    const fallbackTtlMs = 60 * 1000;
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

  const visionModels = passed
    .filter(m => !m.isAudioSpecialized)
    .sort((a, b) => {
      if (b.generation !== a.generation) return b.generation - a.generation;
      const aIsFlash = a.name.includes('flash') ? 1 : 0;
      const bIsFlash = b.name.includes('flash') ? 1 : 0;
      if (bIsFlash !== aIsFlash) return bIsFlash - aIsFlash;
      return (a.latencyMs || 0) - (b.latencyMs || 0);
    });

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

  const photoCandidates: string[] = [];
  for (const rm of reasoningModels) {
    if (!photoCandidates.includes(rm.name)) photoCandidates.push(rm.name);
  }
  for (const vm of visionModels) {
    if (!photoCandidates.includes(vm.name)) photoCandidates.push(vm.name);
  }

  const complexCandidates: string[] = [];
  for (const rm of reasoningModels) {
    if (!complexCandidates.includes(rm.name)) complexCandidates.push(rm.name);
  }
  for (const vm of visionModels) {
    if (!complexCandidates.includes(vm.name)) complexCandidates.push(vm.name);
  }

  const voiceCandidates: string[] = [];
  for (const am of audioModels) {
    if (!voiceCandidates.includes(am.name)) voiceCandidates.push(am.name);
  }
  for (const fm of fallbackFastList) {
    if (!voiceCandidates.includes(fm.name)) voiceCandidates.push(fm.name);
  }

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
      // Trigger background initial discovery
      this.refresh().catch(err => {
        console.warn('[GeminiAutopilot] Первоначальное фоновое обновление моделей завершилось ошибкой:', err?.message || err);
      });

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

    // Stale-While-Revalidate: Plan has expired, return current plan immediately without blocking,
    // and trigger background revalidation to refresh available models pool.
    this.refresh(true).catch(err => {
      console.warn('[GeminiAutopilot] Фоновое обновление моделей завершилось ошибкой:', err?.message || err);
    });

    return this.currentPlan;
  }

  public getActiveModels(role: AutopilotRole = 'general'): string[] {
    const plan = this.getPlan();
    if (role === 'photo') return plan.photoModels;
    if (role === 'voice') return plan.voiceModels;
    if (role === 'complex') return plan.complexModels;
    return plan.generalModels;
  }

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

      eligibleModels.sort((a, b) => {
        const genA = parseGenerationNumber(a.name);
        const genB = parseGenerationNumber(b.name);
        return genB - genA;
      });

      const benchmarkResults = await mapConcurrent(eligibleModels, 4, async m => {
        const ping = await pingModel(m.name, key, config.gemini.pingTimeoutMs || 35000);
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
 * Formats a clean HTML message for Telegram.
 */
export function formatModelReportHtml(report: ModelCheckReport): string {
  const lines: string[] = [
    '🤖 <b>Статус и подбор моделей Gemini</b>',
    `🕒 Проверено: <code>${new Date().toLocaleTimeString('ru-RU')}</code> (в API Google: ${report.totalGoogleModels} моделей)`,
    ''
  ];

  const roleHeaders: Record<ModelRole, { title: string; desc: string }> = {
    photo: { title: '📸 Фото (накладные)', desc: 'быстрое и точное распознавание рукописного текста' },
    voice: { title: '🎙 Голос (аудиозаказы)', desc: 'транскрибация и структурирование речи' },
    complex: { title: '⚡️ Сложные чеки (эскалация)', desc: 'усиленные модели при расхождении сумм' },
    general: { title: '⚙️ Общие модели', desc: 'резервный список' }
  };

  const roles: ModelRole[] = ['photo', 'voice', 'complex'];

  for (const role of roles) {
    const items = report.configured.filter(c => c.role === role);
    if (items.length === 0) continue;

    const meta = roleHeaders[role];
    lines.push(`<b>${meta.title}</b> — <i>${meta.desc}</i>:`);

    for (const item of items) {
      let statusIcon = '✅';
      let details = '';
      if (!item.inGoogleList) {
        statusIcon = '⚠️';
        details = ' (нет в списке Google API)';
      } else if (!item.pingOk) {
        statusIcon = '❌';
        details = item.error ? ` (${escapeHtml(item.error)})` : ' (ошибка отклика)';
      } else if (item.latencyMs !== undefined) {
        details = ` <code>${item.latencyMs} мс</code>`;
      }

      lines.push(`  ${statusIcon} <code>${escapeHtml(item.model)}</code>${details}`);
    }
    lines.push('');
  }

  if (report.recommendations.length > 0) {
    lines.push(
      `💡 <b>Доступны в Google API:</b>\nВы можете добавить их в .env: ${report.recommendations.map(r => `<code>${escapeHtml(r)}</code>`).join(', ')}\n`
    );
  }

  return lines.join('\n');
}

/**
 * Formats report for terminal CLI output.
 */
export function formatModelReportConsole(report: ModelCheckReport): string {
  const lines: string[] = [];
  lines.push('====================================================');
  lines.push('🤖 ПРОВЕРКА АКТУАЛЬНОСТИ И ДОСТУПНОСТИ МОДЕЛЕЙ GEMINI');
  lines.push('====================================================\n');
  lines.push(`Всего моделей в Google Generative Language API: ${report.totalGoogleModels}`);
  lines.push(`Время проверки: ${report.timestamp}\n`);

  const roles: ModelRole[] = ['photo', 'voice', 'complex'];
  const roleNames: Record<ModelRole, string> = {
    photo: '📸 ФОТО (НАКЛАДНЫЕ)',
    voice: '🎙 ГОЛОС (АУДИО)',
    complex: '⚡️ ЭСКАЛАЦИЯ (СЛОЖНЫЕ ЧЕКИ)',
    general: '⚙️ ОБЩИЙ РЕЗЕРВ'
  };

  for (const role of roles) {
    const items = report.configured.filter(c => c.role === role);
    if (items.length === 0) continue;

    lines.push(`--- ${roleNames[role]} ---`);
    for (const item of items) {
      const status = item.pingOk ? '✅ OK' : '❌ FAIL';
      const lat = item.latencyMs !== undefined ? `${item.latencyMs}ms` : 'n/a';
      const err = item.error ? ` [${item.error}]` : '';
      const inApi = item.inGoogleList ? 'Google: YES' : 'Google: NOT FOUND';
      lines.push(`  ${status.padEnd(8)} ${item.model.padEnd(26)} ${lat.padEnd(8)} ${inApi}${err}`);
    }
    lines.push('');
  }

  if (report.recommendations.length > 0) {
    lines.push('💡 РЕКОМЕНДАЦИИ:');
    lines.push(`Следующие поддерживаемые модели есть в вашем аккаунте Google API, но не настроены:`);
    lines.push(`   ${report.recommendations.join(', ')}\n`);
  }

  lines.push('====================================================');
  return lines.join('\n');
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
