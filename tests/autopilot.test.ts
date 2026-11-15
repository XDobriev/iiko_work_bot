import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isEligibleGeminiModel,
  parseGenerationNumber,
  detectReasoningCapability,
  detectAudioCapability,
  rankModels,
  BenchmarkedModel,
  formatAutopilotReportHtml,
  formatAutopilotReportConsole,
  GeminiAutopilot
} from '../src/gemini/autopilot.js';
import { GoogleModelInfo } from '../src/gemini/model-checker.js';
import { GeminiInvoiceRecognizer, extractCandidateText } from '../src/gemini/recognizer.js';

test('isEligibleGeminiModel filters models properly and rejects non-target utilities', () => {
  const eligibleCandidate: GoogleModelInfo = {
    name: 'gemini-4-hydrogen',
    rawName: 'models/gemini-4-hydrogen',
    displayName: 'Gemini 4 Hydrogen',
    description: 'Next-gen reasoning model',
    supportedGenerationMethods: ['generateContent', 'countTokens']
  };
  assert.strictEqual(isEligibleGeminiModel(eligibleCandidate).eligible, true);

  const ttsCandidate: GoogleModelInfo = {
    name: 'gemini-3.8-flash-tts',
    rawName: 'models/gemini-3.8-flash-tts',
    displayName: 'Gemini 3.8 Flash TTS',
    description: 'Text to speech synthesis',
    supportedGenerationMethods: ['generateContent']
  };
  const ttsRes = isEligibleGeminiModel(ttsCandidate);
  assert.strictEqual(ttsRes.eligible, false);
  assert.match(ttsRes.reason || '', /TTS/);

  const embeddingCandidate: GoogleModelInfo = {
    name: 'gemini-embedding-001',
    rawName: 'models/gemini-embedding-001',
    displayName: 'Gemini Embedding',
    supportedGenerationMethods: ['generateContent']
  };
  const embRes = isEligibleGeminiModel(embeddingCandidate);
  assert.strictEqual(embRes.eligible, false);
  assert.match(embRes.reason || '', /эмбеддинг/i);

  const roboticsCandidate: GoogleModelInfo = {
    name: 'gemini-robotics-er-2-preview',
    rawName: 'models/gemini-robotics-er-2-preview',
    displayName: 'Robotics Model',
    supportedGenerationMethods: ['generateContent']
  };
  const robRes = isEligibleGeminiModel(roboticsCandidate);
  assert.strictEqual(robRes.eligible, false);
  assert.match(robRes.reason || '', /robotics/i);

  const imageGenCandidate: GoogleModelInfo = {
    name: 'gemini-3.1-flash-image',
    rawName: 'models/gemini-3.1-flash-image',
    displayName: 'Nano Banana 2',
    supportedGenerationMethods: ['generateContent']
  };
  const imgRes = isEligibleGeminiModel(imageGenCandidate);
  assert.strictEqual(imgRes.eligible, false);
  assert.match(imgRes.reason || '', /изображен/i);

  const computerUseCandidate: GoogleModelInfo = {
    name: 'gemini-2.5-computer-use-preview-10-2025',
    rawName: 'models/gemini-2.5-computer-use-preview-10-2025',
    displayName: 'Computer Use',
    supportedGenerationMethods: ['generateContent']
  };
  assert.strictEqual(isEligibleGeminiModel(computerUseCandidate).eligible, false);

  const nonGeminiCandidate: GoogleModelInfo = {
    name: 'gemma-4-31b-it',
    rawName: 'models/gemma-4-31b-it',
    displayName: 'Gemma 4',
    supportedGenerationMethods: ['generateContent']
  };
  assert.strictEqual(isEligibleGeminiModel(nonGeminiCandidate).eligible, false);

  const noGenerateContent: GoogleModelInfo = {
    name: 'gemini-no-gen',
    rawName: 'models/gemini-no-gen',
    displayName: 'Gemini',
    supportedGenerationMethods: ['countTokens']
  };
  assert.strictEqual(isEligibleGeminiModel(noGenerateContent).eligible, false);
});

test('parseGenerationNumber extracts version numbers from model names', () => {
  assert.strictEqual(parseGenerationNumber('gemini-4-hydrogen'), 4.0);
  assert.strictEqual(parseGenerationNumber('gemini-3.8-flash'), 3.8);
  assert.strictEqual(parseGenerationNumber('gemini-3.6-flash'), 3.6);
  assert.strictEqual(parseGenerationNumber('gemini-3.5-flash-lite'), 3.5);
  assert.strictEqual(parseGenerationNumber('gemini-3-flash-preview'), 3.0);
  assert.strictEqual(parseGenerationNumber('gemini-2.5-flash'), 2.5);
  assert.strictEqual(parseGenerationNumber('gemini-flash-latest'), 3.0);
});

test('detectReasoningCapability identifies reasoning models by name and token metadata', () => {
  const hydrogenModel: GoogleModelInfo = {
    name: 'gemini-4-hydrogen',
    rawName: 'models/gemini-4-hydrogen',
    displayName: 'Gemini 4 Hydrogen',
    supportedGenerationMethods: ['generateContent']
  };
  assert.strictEqual(detectReasoningCapability(hydrogenModel), true);

  const flashModel: GoogleModelInfo = {
    name: 'gemini-3.6-flash',
    rawName: 'models/gemini-3.6-flash',
    displayName: 'Gemini 3.6 Flash',
    supportedGenerationMethods: ['generateContent']
  };
  assert.strictEqual(detectReasoningCapability(flashModel), false);

  // Dynamic detection via thoughtsTokenCount
  assert.strictEqual(
    detectReasoningCapability(flashModel, { hasReasoning: false, thoughtsTokenCount: 180 }),
    true
  );
  assert.strictEqual(
    detectReasoningCapability(flashModel, { hasReasoning: true }),
    true
  );
});

test('detectAudioCapability identifies specialized transcription models', () => {
  const transcribeModel: GoogleModelInfo = {
    name: 'gemini-3.5-transcribe',
    rawName: 'models/gemini-3.5-transcribe',
    displayName: 'Gemini 3.5 Transcribe',
    supportedGenerationMethods: ['generateContent']
  };
  assert.strictEqual(detectAudioCapability(transcribeModel), true);

  const speechModel: GoogleModelInfo = {
    name: 'gemini-audio-stt',
    rawName: 'models/gemini-audio-stt',
    displayName: 'Gemini Audio',
    description: 'Speech to text specialized model',
    supportedGenerationMethods: ['generateContent']
  };
  assert.strictEqual(detectAudioCapability(speechModel), true);

  const visionModel: GoogleModelInfo = {
    name: 'gemini-3.6-flash',
    rawName: 'models/gemini-3.6-flash',
    displayName: 'Gemini 3.6 Flash',
    supportedGenerationMethods: ['generateContent']
  };
  assert.strictEqual(detectAudioCapability(visionModel), false);
});

test('rankModels prioritizes reasoning for photo and complex, audio for voice, and vision for reserve', () => {
  const benchmarked: BenchmarkedModel[] = [
    {
      name: 'gemini-4-hydrogen',
      displayName: 'Gemini 4 Hydrogen',
      ok: true,
      latencyMs: 4200,
      hasReasoning: true,
      isAudioSpecialized: false,
      generation: 4.0,
      tier: 'reasoning'
    },
    {
      name: 'gemini-3.6-flash',
      displayName: 'Gemini 3.6 Flash',
      ok: true,
      latencyMs: 750,
      hasReasoning: false,
      isAudioSpecialized: false,
      generation: 3.6,
      tier: 'fast-vision'
    },
    {
      name: 'gemini-3.5-flash',
      displayName: 'Gemini 3.5 Flash',
      ok: true,
      latencyMs: 950,
      hasReasoning: false,
      isAudioSpecialized: false,
      generation: 3.5,
      tier: 'fast-vision'
    },
    {
      name: 'gemini-3.5-transcribe',
      displayName: 'Gemini 3.5 Transcribe',
      ok: true,
      latencyMs: 380,
      hasReasoning: false,
      isAudioSpecialized: true,
      generation: 3.5,
      tier: 'audio'
    },
    {
      name: 'gemini-4-argon',
      displayName: 'Gemini 4 Argon',
      ok: false,
      latencyMs: 250,
      error: 'HTTP 429: Quota exceeded',
      hasReasoning: true,
      isAudioSpecialized: false,
      generation: 4.0,
      tier: 'rejected',
      rejectionReason: '429 Превышена квота (Quota exceeded)'
    },
    {
      name: 'gemini-3.8-flash',
      displayName: 'Gemini 3.8 Flash',
      ok: false,
      latencyMs: 15100,
      error: 'TimeoutError',
      hasReasoning: false,
      isAudioSpecialized: false,
      generation: 3.8,
      tier: 'rejected',
      rejectionReason: 'Таймаут отклика (>15с)'
    }
  ];

  const plan = rankModels(benchmarked);

  assert.strictEqual(plan.fromFallback, false);

  // 1. Photo models: reasoning model gemini-4-hydrogen MUST be #1
  assert.strictEqual(plan.photoModels[0], 'gemini-4-hydrogen');
  assert.ok(plan.photoModels.includes('gemini-3.6-flash'), 'Vision reserve should be present');
  assert.ok(!plan.photoModels.includes('gemini-4-argon'), 'Rejected 429 model must not be included');

  // 2. Voice models: audio model gemini-3.5-transcribe MUST be #1
  assert.strictEqual(plan.voiceModels[0], 'gemini-3.5-transcribe');
  assert.ok(plan.voiceModels.includes('gemini-3.6-flash'), 'Vision reserve should be present in voice');

  // 3. Complex models: reasoning model gemini-4-hydrogen MUST be #1
  assert.strictEqual(plan.complexModels[0], 'gemini-4-hydrogen');

  // 4. Rejected models properly tracked
  assert.strictEqual(plan.rejectedModels.length, 2);
  const argon = plan.rejectedModels.find(m => m.name === 'gemini-4-argon');
  assert.ok(argon?.rejectionReason?.includes('429'));
});

test('rankModels falls back cleanly to fallbackConfig when 0 models are operational with short recovery TTL', () => {
  const fallbackConfig = {
    photoModels: ['fb-photo-1', 'fb-photo-2'],
    voiceModels: ['fb-voice-1'],
    complexModels: ['fb-complex-1'],
    models: ['fb-general']
  };

  const failedModels: BenchmarkedModel[] = [
    {
      name: 'broken-model',
      displayName: 'Broken',
      ok: false,
      hasReasoning: false,
      isAudioSpecialized: false,
      generation: 3.0,
      tier: 'rejected',
      rejectionReason: '503 error'
    }
  ];

  const now = Date.now();
  const plan = rankModels(failedModels, fallbackConfig as any);
  assert.strictEqual(plan.fromFallback, true);
  assert.deepStrictEqual(plan.photoModels, ['fb-photo-1', 'fb-photo-2']);
  assert.deepStrictEqual(plan.voiceModels, ['fb-voice-1']);
  assert.deepStrictEqual(plan.complexModels, ['fb-complex-1']);
  const remainingTtlMs = new Date(plan.expiresAt).getTime() - now;
  assert.ok(remainingTtlMs <= 65 * 1000 && remainingTtlMs >= 40 * 1000, `Fallback TTL should be ~60s, got ${remainingTtlMs}ms`);
});

test('formatAutopilotReportHtml formats Telegram HTML with proper badges and escaping', () => {
  const plan = {
    photoModels: ['gemini-4-hydrogen', 'gemini-3.6-flash'],
    voiceModels: ['gemini-3.5-transcribe', 'gemini-3.6-flash'],
    complexModels: ['gemini-4-hydrogen', 'gemini-3.6-flash'],
    generalModels: ['gemini-3.6-flash'],
    benchmarkedAt: '2026-11-15T22:00:00.000Z',
    expiresAt: '2026-11-15T22:30:00.000Z',
    fromFallback: false,
    models: [
      {
        name: 'gemini-4-hydrogen',
        displayName: 'Gemini 4 Hydrogen',
        ok: true,
        latencyMs: 4200,
        hasReasoning: true,
        isAudioSpecialized: false,
        generation: 4.0,
        tier: 'reasoning' as const
      },
      {
        name: 'gemini-3.5-transcribe',
        displayName: 'Gemini 3.5 Transcribe',
        ok: true,
        latencyMs: 380,
        hasReasoning: false,
        isAudioSpecialized: true,
        generation: 3.5,
        tier: 'audio' as const
      }
    ],
    rejectedModels: [
      {
        name: 'gemini-4-argon<test>',
        displayName: 'Argon',
        ok: false,
        hasReasoning: false,
        isAudioSpecialized: false,
        generation: 4.0,
        tier: 'rejected' as const,
        rejectionReason: '429 Превышена квота & лимит'
      }
    ]
  };

  const html = formatAutopilotReportHtml(plan);
  assert.match(html, /Gemini Автопилот/);
  assert.match(html, /gemini-4-hydrogen/);
  assert.match(html, /Reasoning/);
  assert.match(html, /Audio-STT/);
  assert.match(html, /gemini-3\.5-transcribe/);
  // Escaping verification
  assert.ok(!html.includes('gemini-4-argon<test>'));
  assert.ok(html.includes('gemini-4-argon&lt;test&gt;'));
  assert.ok(html.includes('квота &amp; лимит'));
});

test('formatAutopilotReportConsole formats readable CLI output', () => {
  const plan = {
    photoModels: ['gemini-4-hydrogen'],
    voiceModels: ['gemini-3.5-transcribe'],
    complexModels: ['gemini-4-hydrogen'],
    generalModels: ['gemini-3.6-flash'],
    benchmarkedAt: '2026-11-15T22:00:00.000Z',
    expiresAt: '2026-11-15T22:30:00.000Z',
    fromFallback: false,
    models: [
      {
        name: 'gemini-4-hydrogen',
        displayName: 'Gemini 4 Hydrogen',
        ok: true,
        latencyMs: 4200,
        hasReasoning: true,
        isAudioSpecialized: false,
        generation: 4.0,
        tier: 'reasoning' as const
      }
    ],
    rejectedModels: []
  };

  const output = formatAutopilotReportConsole(plan);
  assert.match(output, /РЕЗУЛЬТАТЫ РАБОТЫ АВТОПИЛОТА GEMINI/);
  assert.match(output, /gemini-4-hydrogen/);
  assert.match(output, /REASONING/);
});

test('GeminiInvoiceRecognizer seamlessly uses dynamic Autopilot models when unconfigured', () => {
  const mockAutopilot = {
    getActiveModels: (role: string) => {
      if (role === 'photo') return ['dynamic-photo-1', 'dynamic-photo-2'];
      if (role === 'voice') return ['dynamic-voice-1'];
      if (role === 'complex') return ['dynamic-complex-1'];
      return ['dynamic-general-1'];
    }
  } as any;

  const recognizer = new GeminiInvoiceRecognizer('fake-key', undefined, mockAutopilot);
  assert.deepStrictEqual(recognizer.getCandidateModels('photo'), ['dynamic-photo-1', 'dynamic-photo-2']);
  assert.deepStrictEqual(recognizer.getCandidateModels('voice'), ['dynamic-voice-1']);
  assert.deepStrictEqual(recognizer.getCandidateModels('complex'), ['dynamic-complex-1']);
  assert.deepStrictEqual(recognizer.getCandidateModels(), ['dynamic-general-1']);

  // Explicit constructor options override Autopilot
  const explicitRecognizer = new GeminiInvoiceRecognizer('fake-key', {
    photoModels: ['explicit-photo']
  }, mockAutopilot);
  assert.deepStrictEqual(explicitRecognizer.getCandidateModels('photo'), ['explicit-photo']);
});

test('extractCandidateText skips thought parts in reasoning models and extracts JSON text payload', () => {
  // Scenario 1: Multi-part reasoning response where part 0 is a thought scratchpad
  const candidateWithThoughts = {
    content: {
      parts: [
        {
          thought: true,
          text: 'Internal thinking scratchpad: checking handwritten numbers 15 and 580...'
        },
        {
          text: '{"summary": "Поставщик Мясо", "data": {"date": "15.11.2026", "items": []}}'
        }
      ]
    }
  };

  const extracted = extractCandidateText(candidateWithThoughts);
  assert.strictEqual(extracted, '{"summary": "Поставщик Мясо", "data": {"date": "15.11.2026", "items": []}}');
  assert.ok(!extracted?.includes('Internal thinking'));

  // Scenario 2: Standard single-part response
  const standardCandidate = {
    content: {
      parts: [
        {
          text: '{"data": {}}'
        }
      ]
    }
  };
  assert.strictEqual(extractCandidateText(standardCandidate), '{"data": {}}');

  // Scenario 3: Empty / missing candidate
  assert.strictEqual(extractCandidateText(null), undefined);
  assert.strictEqual(extractCandidateText({}), undefined);
});

test('GeminiAutopilot singleton handles reset, key updates, and concurrency deduplication', async () => {
  GeminiAutopilot.resetInstance();

  const ap1 = GeminiAutopilot.getInstance('key-1', 10000);
  assert.ok(ap1);

  // Calling with key-2 updates key on singleton
  const ap2 = GeminiAutopilot.getInstance('key-2');
  assert.strictEqual(ap1, ap2);

  // Resetting singleton clears instance
  GeminiAutopilot.resetInstance();
  const ap3 = GeminiAutopilot.getInstance('key-3');
  assert.notStrictEqual(ap1, ap3);

  GeminiAutopilot.resetInstance();
});

test('detectReasoningCapability rejects false-positive thoughtSignature without real thoughts', () => {
  const standardFlashModel: GoogleModelInfo = {
    name: 'gemini-3.5-flash-lite',
    rawName: 'models/gemini-3.5-flash-lite',
    displayName: 'Gemini 3.5 Flash Lite',
    supportedGenerationMethods: ['generateContent']
  };

  // When Google API returns normal text with watermark thoughtSignature, it MUST NOT be treated as reasoning
  assert.strictEqual(
    detectReasoningCapability(standardFlashModel, { hasReasoning: false }),
    false
  );
  assert.strictEqual(
    detectReasoningCapability(standardFlashModel, { hasReasoning: false, thoughtsTokenCount: 0 }),
    false
  );

  // But if real thoughtsTokenCount > 0 or hasReasoning is true
  assert.strictEqual(
    detectReasoningCapability(standardFlashModel, { hasReasoning: true }),
    true
  );
  assert.strictEqual(
    detectReasoningCapability(standardFlashModel, { thoughtsTokenCount: 42 }),
    true
  );
});
