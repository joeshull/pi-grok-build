import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGrokBuildExtension, type GrokBuildOptions } from "./extension.ts";

export type { GrokDiagnosticLevel, GrokFailureDiagnostic, GrokFailureKind } from "./diagnostics.ts";
export {
  classifyGrokFailure,
  createDiagnostics,
  formatGrokFailure,
  GrokCliError,
  redactGrokArgs,
} from "./diagnostics.ts";
export { createGrokEventBridge } from "./grok-bridge.ts";
export {
  isEndEvent,
  isErrorEvent,
  isResultEvent,
  isStreamEvent,
  isSystemEvent,
  isTextEvent,
  isThoughtEvent,
  parseGrokLine,
} from "./grok-parser.ts";
export {
  buildGrokArgs,
  captureStderr,
  detectGrokBinary,
  detectGrokBinaryEffect,
  forceKillProcess,
  getGrokVersion,
  killAllProcesses,
  parseGrokModelsOutput,
  registerProcess,
  runGrokCommand,
  runGrokCommandAsync,
  runGrokInspect,
  runGrokMemory,
  runGrokModels,
  runGrokModelsAsync,
  runGrokSessions,
  runGrokShare,
  runGrokTrace,
  spawnGrok,
  validateGrokAuth,
  validateGrokPresence,
} from "./grok-runner.ts";
export {
  buildGrokProviderModel,
  buildGrokProviderModels,
  fallbackGrokBuildModel,
  GROK_BUILD_PROVIDER_ID,
  GROK_JSONL_INTEGRATION_MODE,
  GROK_PROVIDER_MODEL_DEFAULTS,
  GROK_THINKING_LEVEL_MAP,
} from "./model-metadata.ts";
export { buildGrokPrompt, buildSpawnOptions, contextHasImages, streamViaGrok } from "./provider.ts";
export type {
  GrokEffortLevel,
  GrokEndEvent,
  GrokErrorEvent,
  GrokModelDescriptor,
  GrokNdjsonMessage,
  GrokPermissionMode,
  GrokReasoningEffort,
  GrokResultEvent,
  GrokRunResult,
  GrokSessionDescriptor,
  GrokSpawnOptions,
  GrokStreamEvent,
  GrokSystemEvent,
  GrokTextEvent,
  GrokThoughtEvent,
  TrackedBlock,
  TrackedContentBlock,
  TrackedToolBlock,
} from "./types.ts";
export type {
  ImagineImageResult,
  PollVideoGenerationResult,
  StartVideoGenerationResult,
  VideoGenerationStatus,
} from "./xai-api.ts";
export {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  getXaiApiKey,
  imagineImage,
  imagineVideo,
  pollVideoGeneration,
  startVideoGeneration,
} from "./xai-api.ts";
export type { GrokBuildOptions };
export { createGrokBuildExtension };

export default function piGrokBuildExtension(pi: ExtensionAPI): void {
  createGrokBuildExtension().register(pi);
}
