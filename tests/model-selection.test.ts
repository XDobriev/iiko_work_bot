import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isEligibleGeminiModel,
  parseGenerationNumber,
  detectReasoningCapability,
  detectAudioCapability,
  rankModels,
  BenchmarkedModel,
  GeminiAutopilot,
  formatModelReportHtml,
  formatModelReportConsole,
  formatAutopilotReportHtml,
  formatAutopilotReportConsole,
  GoogleModelInfo
} from '../src/gemini/model-selection.js';

test('model-selection: isEligibleGeminiModel classifies candidate models correctly', () => {
  const goodModel: GoogleModelInfo = {
    name: 'gemini-3.5-flash',
    rawName: 'models/gemini-3.5-flash',
    displayName: 'Gemini 3.5 Flash',
    supportedGenerationMethods: ['generateContent']
  };
  assert.equal(isEligibleGeminiModel(goodModel).eligible, true);

  const ttsModel: GoogleModelInfo = {
    name: 'gemini-3.5-flash-tts',
    rawName: 'models/gemini-3.5-flash-tts',
    displayName: 'TTS Model',
    supportedGenerationMethods: ['generateContent']
  };
  assert.equal(isEligibleGeminiModel(ttsModel).eligible, false);

  const embModel: GoogleModelInfo = {
    name: 'gemini-embedding-exp',
    rawName: 'models/gemini-embedding-exp',
    displayName: 'Embedding',
    supportedGenerationMethods: ['generateContent']
  };
  assert.equal(isEligibleGeminiModel(embModel).eligible, false);

  const nonGenModel: GoogleModelInfo = {
    name: 'gemini-no-gen',
    rawName: 'models/gemini-no-gen',
    displayName: 'No Gen',
    supportedGenerationMethods: ['countTokens']
  };
  assert.equal(isEligibleGeminiModel(nonGenModel).eligible, false);
});

test('model-selection: detectReasoningCapability and detectAudioCapability identify specialized roles', () => {
  const reasoningInfo: GoogleModelInfo = {
    name: 'gemini-3-deep-think',
    rawName: 'models/gemini-3-deep-think',
    displayName: 'Thinking Model',
    supportedGenerationMethods: ['generateContent']
  };
  assert.equal(detectReasoningCapability(reasoningInfo), true);

  const pingWithThoughts = { ok: true, hasReasoning: true, thoughtsTokenCount: 120 };
  const genericInfo: GoogleModelInfo = {
    name: 'gemini-2.5-flash',
    rawName: 'models/gemini-2.5-flash',
    displayName: 'Generic Flash',
    supportedGenerationMethods: ['generateContent']
  };
  assert.equal(detectReasoningCapability(genericInfo, pingWithThoughts), true);

  const audioInfo: GoogleModelInfo = {
    name: 'gemini-3.5-transcribe',
    rawName: 'models/gemini-3.5-transcribe',
    displayName: 'Transcribe Audio',
    supportedGenerationMethods: ['generateContent']
  };
  assert.equal(detectAudioCapability(audioInfo), true);
  assert.equal(detectAudioCapability(genericInfo), false);
});

test('model-selection: rankModels builds prioritized AutopilotPlan', () => {
  const benchmarked: BenchmarkedModel[] = [
    {
      name: 'gemini-3.5-think',
      displayName: 'Reasoning 3.5',
      ok: true,
      latencyMs: 800,
      hasReasoning: true,
      isAudioSpecialized: false,
      generation: 3.5,
      tier: 'reasoning'
    },
    {
      name: 'gemini-3.5-flash',
      displayName: 'Flash 3.5',
      ok: true,
      latencyMs: 300,
      hasReasoning: false,
      isAudioSpecialized: false,
      generation: 3.5,
      tier: 'fast-vision'
    },
    {
      name: 'gemini-3.5-stt',
      displayName: 'Audio STT',
      ok: true,
      latencyMs: 400,
      hasReasoning: false,
      isAudioSpecialized: true,
      generation: 3.5,
      tier: 'audio'
    },
    {
      name: 'gemini-broken',
      displayName: 'Broken',
      ok: false,
      latencyMs: 9999,
      hasReasoning: false,
      isAudioSpecialized: false,
      generation: 2.0,
      tier: 'rejected',
      rejectionReason: '429 Quota Exceeded'
    }
  ];

  const plan = rankModels(benchmarked);
  assert.equal(plan.fromFallback, false);
  assert.ok(plan.photoModels.includes('gemini-3.5-think'));
  assert.ok(plan.photoModels.includes('gemini-3.5-flash'));
  assert.ok(plan.voiceModels.includes('gemini-3.5-stt'));
  assert.ok(plan.complexModels.includes('gemini-3.5-think'));
  assert.equal(plan.rejectedModels.length, 1);
  assert.equal(plan.rejectedModels[0].name, 'gemini-broken');
});

test('model-selection: GeminiAutopilot singleton lifecycle and getActiveModels', () => {
  GeminiAutopilot.resetInstance();
  const autopilot = GeminiAutopilot.getInstance('mock-key', 60000);
  assert.ok(autopilot);

  const photoModels = autopilot.getActiveModels('photo');
  assert.ok(Array.isArray(photoModels));
  assert.ok(photoModels.length > 0);

  const voiceModels = autopilot.getActiveModels('voice');
  assert.ok(Array.isArray(voiceModels));
  assert.ok(voiceModels.length > 0);

  const plan = autopilot.getPlan();
  assert.ok(plan);
  assert.ok(plan.photoModels.length > 0);

  GeminiAutopilot.resetInstance();
});

test('model-selection: formatting reports for HTML and console output', () => {
  const plan = rankModels([
    {
      name: 'gemini-3.5-flash',
      displayName: 'Flash',
      ok: true,
      latencyMs: 250,
      hasReasoning: false,
      isAudioSpecialized: false,
      generation: 3.5,
      tier: 'fast-vision'
    }
  ]);

  const html = formatAutopilotReportHtml(plan);
  assert.ok(html.includes('Gemini Автопилот'));
  assert.ok(html.includes('gemini-3.5-flash'));
  assert.ok(html.includes('250 мс'));

  const cli = formatAutopilotReportConsole(plan);
  assert.ok(cli.includes('РЕЗУЛЬТАТЫ РАБОТЫ АВТОПИЛОТА GEMINI'));
  assert.ok(cli.includes('gemini-3.5-flash'));
});
