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

export interface PingResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
  hasReasoning?: boolean;
  thoughtsTokenCount?: number;
}

/**
 * Sends a lightweight prompt to verify model accessibility and measure response latency.
 */
export async function pingModel(
  model: string,
  apiKey?: string
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
      signal: AbortSignal.timeout(15000)
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
 * Examples:
 *  "gemini-4-hydrogen" -> 4.0
 *  "gemini-3.8-flash" -> 3.8
 *  "gemini-3.6-flash" -> 3.6
 *  "gemini-3.5-flash-lite" -> 3.5
 *  "gemini-3-flash-preview" -> 3.0
 *  "gemini-2.5-flash" -> 2.5
 *  "gemini-flash-latest" -> 3.0
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
 * Determines whether a model is an eligible text/vision/audio candidate for Gemini Autopilot,
 * eliminating service models (pure TTS, embeddings, robotics, pure image generators).
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

  // Ping cache to avoid testing duplicate models twice
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

  // Calculate recommendations dynamically: any eligible Gemini models not yet configured
  const configuredSet = new Set(configured.map(c => c.model.toLowerCase()));
  const recommendations: string[] = [];

  // Filter Google models dynamically using isEligibleGeminiModel without hardcoding
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
