/**
 * Backward compatibility facade for Gemini Autopilot.
 * All core implementations are consolidated into model-selection.ts.
 */
export type {
  GoogleModelInfo,
  ModelRole,
  AutopilotRole,
  ModelTier,
  BenchmarkedModel,
  AutopilotPlan
} from './model-selection.js';

export {
  isEligibleGeminiModel,
  parseGenerationNumber,
  detectReasoningCapability,
  detectAudioCapability,
  rankModels,
  GeminiAutopilot,
  formatAutopilotReportHtml,
  formatAutopilotReportConsole
} from './model-selection.js';
