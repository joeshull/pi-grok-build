import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildGrokProviderModel,
  buildGrokProviderModels,
  fallbackGrokBuildModel,
  GROK_BUILD_PROVIDER_ID,
  GROK_DEFAULT_INTEGRATION_MODE,
  GROK_JSONL_INTEGRATION_MODE,
  GROK_THINKING_LEVEL_MAP,
} from "../../src/model-metadata.ts";

describe("Grok provider metadata", () => {
  it("uses honest provider and integration identifiers", () => {
    assert.equal(GROK_BUILD_PROVIDER_ID, "pi-grok-build");
    assert.equal(GROK_DEFAULT_INTEGRATION_MODE, "acp");
    assert.equal(GROK_JSONL_INTEGRATION_MODE, "jsonl");
  });

  it("maps Pi thinking levels to Grok reasoning effort values", () => {
    assert.deepEqual(GROK_THINKING_LEVEL_MAP, {
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    });
  });

  it("builds provider models from CLI descriptors without claiming unproven image input", () => {
    const model = buildGrokProviderModel({ id: "grok-build", name: "Grok Build" });
    assert.equal(model.id, "grok-build");
    assert.equal(model.name, "Grok Build");
    assert.equal(model.reasoning, true);
    assert.deepEqual(model.thinkingLevelMap, GROK_THINKING_LEVEL_MAP);
    assert.deepEqual(model.input, ["text"]);
    assert.equal(model.cost.input, 0);
    assert.equal(model.cost.output, 0);
  });

  it("preserves CLI model order exactly", () => {
    const models = buildGrokProviderModels([
      { id: "grok-build", name: "grok-build" },
      { id: "kimi-k2p6-turbo-firepass", name: "kimi-k2p6-turbo-firepass" },
    ]);
    assert.deepEqual(
      models.map((model) => model.id),
      ["grok-build", "kimi-k2p6-turbo-firepass"],
    );
  });

  it("fallback model is the id grok CLI actually offers", () => {
    // grok 0.2.112 retired `grok-build`; `grok models` lists only grok-4.5.
    assert.equal(fallbackGrokBuildModel().id, "grok-4.5");
    assert.equal(fallbackGrokBuildModel().name, "Grok 4.5");
  });
});
