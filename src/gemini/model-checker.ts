/**
 * Backward compatibility facade for model checking utilities.
 * All core implementations are consolidated into model-selection.ts.
 */
export type {
  GoogleModelInfo,
  ModelRole,
  ModelCheckItem,
  ModelCheckReport,
  PingResult
} from './model-selection.js';

export {
  fetchGoogleModels,
  pingModel,
  parseGenerationNumber,
  isEligibleGeminiModel,
  detectReasoningCapability,
  detectAudioCapability,
  checkConfiguredModels,
  formatModelReportHtml,
  formatModelReportConsole
} from './model-selection.js';
