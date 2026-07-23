import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect } from "effect";
import { isEndEvent, isErrorEvent, isTextEvent, parseGrokLine } from "../../../src/grok-parser.ts";
import {
  buildGrokArgs,
  detectGrokBinary,
  detectGrokBinaryEffect,
  getGrokVersion,
  parseGrokModelsOutput,
  runGrokCommand,
  runGrokInspect,
  runGrokMemory,
  runGrokModels,
  runGrokSessions,
  runGrokTrace,
  validateGrokPresence,
} from "../../../src/grok-runner.ts";

describe("buildGrokArgs", () => {
  it("builds minimal args", () => {
    const args = buildGrokArgs("hello", {});
    assert.deepEqual(args, ["-p", "hello", "--output-format", "streaming-json"]);
  });

  it("adds modelId", () => {
    const args = buildGrokArgs("hi", { modelId: "grok-3" });
    assert.ok(args.includes("--model"));
    assert.ok(args.includes("grok-3"));
  });

  it("adds sessionId", () => {
    const args = buildGrokArgs("hi", { sessionId: "abc" });
    assert.ok(args.includes("--session-id"));
    assert.ok(args.includes("abc"));
  });

  it("adds resumeSessionId", () => {
    const args = buildGrokArgs("hi", { resumeSessionId: "xyz" });
    assert.ok(args.includes("--resume"));
    assert.ok(args.includes("xyz"));
  });

  it("adds continueSession", () => {
    const args = buildGrokArgs("hi", { continueSession: true });
    assert.ok(args.includes("--continue"));
  });

  it("adds workingDirectory", () => {
    const args = buildGrokArgs("hi", { workingDirectory: "/tmp" });
    assert.ok(args.includes("--cwd"));
    assert.ok(args.includes("/tmp"));
  });

  it("adds alwaysApprove", () => {
    const args = buildGrokArgs("hi", { alwaysApprove: true });
    assert.ok(args.includes("--always-approve"));
  });

  it("adds effort", () => {
    const args = buildGrokArgs("hi", { effort: "high" });
    assert.deepEqual(
      args.filter((_, i) => args[i - 1] === "--effort"),
      ["high"],
    );
  });

  it("adds maxTurns", () => {
    const args = buildGrokArgs("hi", { maxTurns: 5 });
    assert.deepEqual(
      args.filter((_, i) => args[i - 1] === "--max-turns"),
      ["5"],
    );
  });

  it("adds reasoningEffort", () => {
    const args = buildGrokArgs("hi", { reasoningEffort: "medium" });
    assert.deepEqual(
      args.filter((_, i) => args[i - 1] === "--reasoning-effort"),
      ["medium"],
    );
  });

  it("adds check", () => {
    const args = buildGrokArgs("hi", { check: true });
    assert.ok(args.includes("--check"));
  });

  it("does not expose best-of-n in provider args", () => {
    const args = buildGrokArgs("hi", { bestOfN: 3 } as any);
    assert.ok(!args.includes("--best-of-n"));
  });

  it("adds verbatim", () => {
    const args = buildGrokArgs("hi", { verbatim: true });
    assert.ok(args.includes("--verbatim"));
  });

  it("adds disableWebSearch", () => {
    const args = buildGrokArgs("hi", { disableWebSearch: true });
    assert.ok(args.includes("--disable-web-search"));
  });

  it("adds noSubagents", () => {
    const args = buildGrokArgs("hi", { noSubagents: true });
    assert.ok(args.includes("--no-subagents"));
  });

  it("adds noPlan", () => {
    const args = buildGrokArgs("hi", { noPlan: true });
    assert.ok(args.includes("--no-plan"));
  });

  it("adds noMemory", () => {
    const args = buildGrokArgs("hi", { noMemory: true });
    assert.ok(args.includes("--no-memory"));
  });

  it("adds experimentalMemory", () => {
    const args = buildGrokArgs("hi", { experimentalMemory: true });
    assert.ok(args.includes("--experimental-memory"));
  });

  it("adds permissionMode", () => {
    const args = buildGrokArgs("hi", { permissionMode: "auto" });
    assert.deepEqual(
      args.filter((_, i) => args[i - 1] === "--permission-mode"),
      ["auto"],
    );
  });

  it("adds rules", () => {
    const args = buildGrokArgs("hi", { rules: "Be concise" });
    assert.deepEqual(
      args.filter((_, i) => args[i - 1] === "--rules"),
      ["Be concise"],
    );
  });

  it("adds systemPromptOverride", () => {
    const args = buildGrokArgs("hi", { systemPromptOverride: "You are a robot" });
    assert.deepEqual(
      args.filter((_, i) => args[i - 1] === "--system-prompt-override"),
      ["You are a robot"],
    );
  });

  it("adds tools", () => {
    const args = buildGrokArgs("hi", { tools: "read,write" });
    assert.deepEqual(
      args.filter((_, i) => args[i - 1] === "--tools"),
      ["read,write"],
    );
  });

  it("adds disallowedTools", () => {
    const args = buildGrokArgs("hi", { disallowedTools: "web_search" });
    assert.deepEqual(
      args.filter((_, i) => args[i - 1] === "--disallowed-tools"),
      ["web_search"],
    );
  });

  it("adds allowRules", () => {
    const args = buildGrokArgs("hi", { allowRules: ["edit:*", "write:*"] });
    assert.ok(args.includes("--allow"));
    assert.ok(args.includes("edit:*"));
    assert.ok(args.includes("write:*"));
  });

  it("adds denyRules", () => {
    const args = buildGrokArgs("hi", { denyRules: ["exec:*"] });
    assert.ok(args.includes("--deny"));
    assert.ok(args.includes("exec:*"));
  });

  it("adds sandbox", () => {
    const args = buildGrokArgs("hi", { sandbox: "strict" });
    assert.deepEqual(
      args.filter((_, i) => args[i - 1] === "--sandbox"),
      ["strict"],
    );
  });

  it("adds restoreCode (0.1.216)", () => {
    const args = buildGrokArgs("hi", { restoreCode: true });
    assert.ok(args.includes("--restore-code"));
  });

  it("does not expose Grok agent/subagent orchestration args", () => {
    const args = buildGrokArgs("hi", {
      agent: "grok-build-plan",
      agents: '{"foo": {"model": "grok-4"}}',
      worktree: true,
    } as any);
    assert.ok(!args.includes("--agent"));
    assert.ok(!args.includes("--agents"));
    assert.ok(!args.includes("--worktree"));
  });

  it("supports expanded reasoningEffort values (0.1.216)", () => {
    const args = buildGrokArgs("hi", { reasoningEffort: "xhigh" });
    assert.deepEqual(
      args.filter((_, i) => args[i - 1] === "--reasoning-effort"),
      ["xhigh"],
    );
  });

  it("combines multiple flags in correct order", () => {
    const args = buildGrokArgs("test", {
      modelId: "grok-3",
      effort: "high",
      maxTurns: 10,
      check: true,
      alwaysApprove: true,
    });
    assert.ok(args.indexOf("-p") < args.indexOf("test"));
    assert.ok(args.indexOf("--model") < args.indexOf("grok-3"));
    assert.ok(args.indexOf("--effort") < args.indexOf("high"));
    assert.ok(args.indexOf("--max-turns") < args.indexOf("10"));
    assert.ok(args.includes("--check"));
    assert.ok(args.includes("--always-approve"));
  });
});

describe("detectGrokBinary", () => {
  it("returns 'grok' when available", () => {
    const bin = detectGrokBinary();
    assert.equal(bin, "grok");
  });

  it("has an Effect-modeled detection API", () => {
    const bin = Effect.runSync(detectGrokBinaryEffect());
    assert.equal(bin, "grok");
  });
});

describe("validateGrokPresence", () => {
  it("does not throw when grok is installed", () => {
    assert.doesNotThrow(() => validateGrokPresence());
  });
});

describe("getGrokVersion", () => {
  it("returns a version string containing 'grok'", () => {
    const version = getGrokVersion();
    assert.ok(version.includes("grok"), `expected version to include 'grok', got: ${version}`);
  });
});

describe("runGrokCommand", () => {
  it("runs 'grok --version' successfully", () => {
    const result = runGrokCommand(["--version"]);
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("grok"));
  });

  it("runs 'grok models' successfully when authed", () => {
    const result = runGrokCommand(["models"]);
    if (result.ok) {
      assert.ok(result.stdout.length > 0);
    } else {
      // If unauthed, at least verify we got a structured failure
      assert.equal(result.ok, false);
      assert.ok(result.stderr.length > 0 || result.stdout.length > 0);
    }
  });

  it("handles unknown flags gracefully", () => {
    const result = runGrokCommand(["--this-flag-definitely-does-not-exist-12345"]);
    assert.equal(result.ok, false);
  });
});

describe("runGrokModels", () => {
  it("returns structured model data when authed", () => {
    const result = runGrokModels();
    if (result.ok) {
      const models = parseGrokModelsOutput(result.stdout);
      assert.ok(models.length > 0, "expected at least one model");
      assert.ok(models.some((m) => m.id.includes("grok")));
    }
  });
});

describe("runGrokInspect", () => {
  it("returns JSON or text about discovered config", () => {
    const result = runGrokInspect();
    // inspect may fail if unauthed in some versions, but usually works
    assert.ok(result.stdout.length > 0 || result.stderr.length > 0);
  });
});

describe("runGrokSessions", () => {
  it("returns something (empty list is fine)", () => {
    const result = runGrokSessions();
    assert.ok(typeof result.stdout === "string");
  });
});

describe("runGrokMemory", () => {
  it("returns something (empty list is fine)", () => {
    const result = runGrokMemory();
    assert.ok(typeof result.stdout === "string");
  });
});

describe("runGrokTrace", () => {
  it("returns something", () => {
    const result = runGrokTrace();
    assert.ok(typeof result.stdout === "string");
  });
});

describe("parseGrokLine", () => {
  it("classifies top-level Grok CLI error events", () => {
    const msg = parseGrokLine('{"type":"error","message":"unknown model id"}');
    assert.ok(msg);
    assert.equal(isErrorEvent(msg), true);
    if (isErrorEvent(msg)) {
      assert.equal(msg.message, "unknown model id");
    }
  });

  it("classifies current Grok CLI text and end events", () => {
    const text = parseGrokLine('{"type":"text","data":"hello"}');
    assert.ok(text);
    assert.equal(isTextEvent(text), true);

    const end = parseGrokLine('{"type":"end","stopReason":"EndTurn","requestId":"req_123"}');
    assert.ok(end);
    assert.equal(isEndEvent(end), true);
  });
});

describe("parseGrokModelsOutput", () => {
  it("parses JSON array", () => {
    const json = JSON.stringify([
      { id: "grok-3", name: "Grok 3" },
      { id: "grok-2", name: "Grok 2" },
    ]);
    const models = parseGrokModelsOutput(json);
    assert.equal(models.length, 2);
    assert.equal(models[0]!.id, "grok-3");
  });

  it("parses JSON object with models array", () => {
    const json = JSON.stringify({
      models: [{ id: "grok-4.3", name: "Grok 4.3" }],
    });
    const models = parseGrokModelsOutput(json);
    assert.equal(models.length, 1);
    assert.equal(models[0]!.name, "Grok 4.3");
  });

  it("parses plain text lines", () => {
    const text = "grok-3        Grok 3\ngrok-2        Grok 2\n";
    const models = parseGrokModelsOutput(text);
    assert.equal(models.length, 2);
    assert.equal(models[1]!.id, "grok-2");
  });

  it("ignores Grok CLI status prose", () => {
    const text = [
      "You are logged in with grok.com.",
      "",
      "Default model: grok-4.5",
      "",
      "Available models:",
      "  * grok-4.5 (default)",
    ].join("\n");

    assert.deepEqual(parseGrokModelsOutput(text), [{ id: "grok-4.5", name: "grok-4.5" }]);
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(parseGrokModelsOutput(""), []);
    assert.deepEqual(parseGrokModelsOutput("   "), []);
  });

  it("returns empty array for invalid JSON without text matches", () => {
    assert.deepEqual(parseGrokModelsOutput("{broken}"), []);
  });

  it("deduplicates by id", () => {
    const text = "grok-3  Grok 3\ngrok-3  Grok 3 Again\n";
    const models = parseGrokModelsOutput(text);
    assert.equal(models.length, 1);
  });
});
