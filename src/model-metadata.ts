import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { GrokModelDescriptor } from "./types.ts";

export const GROK_BUILD_PROVIDER_ID = "pi-grok-build";
/** The only model Grok CLI 0.2.112 offers (`grok models`). */
export const GROK_DEFAULT_MODEL_ID = "grok-4.5";
export const GROK_JSONL_INTEGRATION_MODE = "jsonl";
export const GROK_DEFAULT_INTEGRATION_MODE = "acp";

export const GROK_THINKING_LEVEL_MAP = {
  off: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
} as const;

export const GROK_PROVIDER_MODEL_DEFAULTS = {
  reasoning: true,
  thinkingLevelMap: GROK_THINKING_LEVEL_MAP,
  input: ["text"] as const,
  contextWindow: 1_000_000,
  maxTokens: 128_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies Omit<ProviderModelConfig, "id" | "name">;

export function buildGrokProviderModel(descriptor: GrokModelDescriptor): ProviderModelConfig {
  return {
    id: descriptor.id,
    name: descriptor.name,
    ...GROK_PROVIDER_MODEL_DEFAULTS,
  };
}

export function buildGrokProviderModels(
  descriptors: readonly GrokModelDescriptor[],
): ProviderModelConfig[] {
  return descriptors.map(buildGrokProviderModel);
}

/**
 * Model registered when live discovery has not (yet) run.
 *
 * Grok CLI 0.2.112 retired the `grok-build` model id — `grok models` now offers
 * only `grok-4.5`, and passing `--model grok-build` is silently ignored by the
 * CLI, which routes to grok-4.5 anyway. Registering the real id keeps Pi's model
 * list honest and stops omp warning about an unknown model in its role and
 * fallback-chain config.
 */
export function fallbackGrokBuildModel(): ProviderModelConfig {
  return buildGrokProviderModel({ id: GROK_DEFAULT_MODEL_ID, name: "Grok 4.5" });
}
