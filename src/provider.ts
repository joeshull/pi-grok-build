/**
 * Provider orchestration for bridging Pi requests to the Grok Build CLI.
 *
 * streamViaGrok is the core function that:
 * 1. Formats conversation context as a text prompt
 * 2. Spawns `grok -p "prompt" --output-format streaming-json`
 * 3. Reads stdout line-by-line, parsing NDJSON
 * 4. Routes events through the event bridge to Pi's stream
 * 5. Handles result/error and cleans up the subprocess
 * 6. Hardened: inactivity timeout, abort handling, process registry
 */

import { createInterface } from "node:readline";
import {
  type AssistantMessageEvent,
  AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  type GrokIntegrationMode,
  resolveGrokIntegrationMode,
  streamViaGrokAcp,
} from "./acp-mode.ts";
import { createContentBlockSequencer } from "./content-blocks.ts";
import { classifyGrokFailure, createDiagnostics, formatGrokFailure } from "./diagnostics.ts";
import { createGrokEventBridge } from "./grok-bridge.ts";
import {
  isEndEvent,
  isErrorEvent,
  isResultEvent,
  isStreamEvent,
  isTextEvent,
  isThoughtEvent,
  parseGrokLine,
} from "./grok-parser.ts";
import { captureStderr, forceKillProcess, registerProcess, spawnGrok } from "./grok-runner.ts";
import type { GrokSpawnOptions } from "./types.ts";

/** Inactivity timeout: kill subprocess if no stdout for 180 seconds. */
const INACTIVITY_TIMEOUT_MS = 180_000;
const diagnostics = createDiagnostics("provider");

/** Extended stream options with optional session info and advanced headless flags. */
type StreamViaGrokOptions = SimpleStreamOptions & {
  cwd?: string;
  sessionId?: string;

  // Advanced headless passthroughs
  effort?: GrokSpawnOptions["effort"];
  maxTurns?: GrokSpawnOptions["maxTurns"];
  reasoningEffort?: GrokSpawnOptions["reasoningEffort"];
  check?: GrokSpawnOptions["check"];
  verbatim?: GrokSpawnOptions["verbatim"];
  disableWebSearch?: GrokSpawnOptions["disableWebSearch"];
  noMemory?: GrokSpawnOptions["noMemory"];
  experimentalMemory?: GrokSpawnOptions["experimentalMemory"];
  permissionMode?: GrokSpawnOptions["permissionMode"];
  rules?: GrokSpawnOptions["rules"];
  systemPromptOverride?: GrokSpawnOptions["systemPromptOverride"];
  tools?: GrokSpawnOptions["tools"];
  disallowedTools?: GrokSpawnOptions["disallowedTools"];
  allowRules?: GrokSpawnOptions["allowRules"];
  denyRules?: GrokSpawnOptions["denyRules"];
  sandbox?: GrokSpawnOptions["sandbox"];
  workingDirectory?: GrokSpawnOptions["workingDirectory"];
  continueSession?: GrokSpawnOptions["continueSession"];

  // 0.1.216 passthroughs
  restoreCode?: GrokSpawnOptions["restoreCode"];
  oauth?: GrokSpawnOptions["oauth"];
  promptFile?: GrokSpawnOptions["promptFile"];
  promptJson?: GrokSpawnOptions["promptJson"];

  /** Override PI_GROK_BUILD_MODE for tests/direct SDK callers. */
  integrationMode?: GrokIntegrationMode;
};

/** Pi content block shape (minimal). */
interface PiContentBlock {
  type: string;
  text?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  thinking?: string;
  data?: string; // base64 image data
  mimeType?: string;
}

/**
 * Build a flat text prompt from Pi conversation context.
 * Labels messages with USER: / ASSISTANT: / TOOL RESULT: roles.
 *
 * Supports image placeholders for vision models.
 */
export function buildGrokPrompt(context: {
  messages: Array<{ role: string; content: unknown; toolName?: string }>;
}): string {
  const parts: string[] = [];

  for (const msg of context.messages) {
    if (msg.role === "user") {
      parts.push("USER:");
      parts.push(contentToText(msg.content));
    } else if (msg.role === "assistant") {
      parts.push("ASSISTANT:");
      parts.push(contentToText(msg.content));
    } else if (msg.role === "toolResult") {
      const name = msg.toolName ?? "unknown";
      parts.push(`TOOL RESULT (${name}):`);
      parts.push(contentToText(msg.content));
    }
  }

  return parts.join("\n") || "";
}

/** Extract text from arbitrary content types. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block: PiContentBlock) => {
      if (block.type === "text") return String(block.text ?? "");
      if (block.type === "toolCall") {
        return `[Tool call: ${block.name} args=${JSON.stringify(block.arguments ?? {})}]`;
      }
      if (block.type === "thinking") return "";
      if (block.type === "image") return "[Image]";
      return "";
    })
    .join("\n");
}

/**
 * Detect if any message in the context contains image content.
 * Returns true if a vision-capable model should be used.
 */
export function contextHasImages(context: {
  messages: Array<{ role: string; content: unknown }>;
}): boolean {
  for (const msg of context.messages) {
    if (typeof msg.content === "string") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content as PiContentBlock[]) {
      if (block && block.type === "image") return true;
    }
  }
  return false;
}

/**
 * Build GrokSpawnOptions from StreamViaGrokOptions.
 * Bridges Pi provider options to Grok CLI flags.
 */
export function buildSpawnOptions(
  model: Model<any>,
  options?: StreamViaGrokOptions,
): GrokSpawnOptions {
  const spawnOpts: GrokSpawnOptions = {
    modelId: model.id,
    alwaysApprove: true,
    // Grok Build subagents can hang in non-interactive Pi provider calls when
    // their worker auth channel is unavailable. Pi already owns orchestration;
    // default provider calls to a single Grok turn unless explicitly overridden.
    noSubagents: true,
    noPlan: true,
    maxTurns: 1,
  };

  if (options?.cwd !== undefined) spawnOpts.cwd = options.cwd;
  if (options?.sessionId) spawnOpts.sessionId = options.sessionId;
  if (options?.effort) spawnOpts.effort = options.effort;
  if (options?.maxTurns != null) spawnOpts.maxTurns = options.maxTurns;
  if (options?.reasoningEffort) spawnOpts.reasoningEffort = options.reasoningEffort;
  if (options?.check) spawnOpts.check = options.check;
  if (options?.verbatim) spawnOpts.verbatim = options.verbatim;
  if (options?.disableWebSearch) spawnOpts.disableWebSearch = options.disableWebSearch;
  // Provider mode owns orchestration; Grok subagents are intentionally out of scope.
  // Keep plan mode disabled for one-shot Pi print/json/rpc provider calls.
  if (options?.noMemory) spawnOpts.noMemory = options.noMemory;
  if (options?.experimentalMemory) spawnOpts.experimentalMemory = options.experimentalMemory;
  if (options?.permissionMode) spawnOpts.permissionMode = options.permissionMode;
  if (options?.rules) spawnOpts.rules = options.rules;
  if (options?.systemPromptOverride) spawnOpts.systemPromptOverride = options.systemPromptOverride;
  if (options?.tools) spawnOpts.tools = options.tools;
  if (options?.disallowedTools) spawnOpts.disallowedTools = options.disallowedTools;
  if (options?.allowRules) spawnOpts.allowRules = options.allowRules;
  if (options?.denyRules) spawnOpts.denyRules = options.denyRules;
  if (options?.sandbox) spawnOpts.sandbox = options.sandbox;
  if (options?.workingDirectory) spawnOpts.workingDirectory = options.workingDirectory;
  if (options?.continueSession) spawnOpts.continueSession = options.continueSession;

  // 0.1.216 additions
  if (options?.restoreCode) spawnOpts.restoreCode = options.restoreCode;
  if (options?.oauth) spawnOpts.oauth = options.oauth;
  if (options?.promptFile) spawnOpts.promptFile = options.promptFile;
  if (options?.promptJson) spawnOpts.promptJson = options.promptJson;

  return spawnOpts;
}

/**
 * Stream a response from Grok CLI as an AssistantMessageEventStream.
 *
 * Orchestrates the full subprocess lifecycle: spawn, parse NDJSON,
 * bridge events, handle result, and clean up.
 */
export function streamViaGrok(
  model: Model<any>,
  context: { messages: Array<{ role: string; content: unknown }>; systemPrompt?: string },
  options?: StreamViaGrokOptions,
): AssistantMessageEventStream {
  // @ts-expect-error — pi-ai exports AssistantMessageEventStream as export type.
  // The class constructor exists at runtime and Pi's ESM loader resolves it correctly.
  const stream = new AssistantMessageEventStream();

  (async () => {
    let proc: ReturnType<typeof spawnGrok> | undefined;
    let abortHandler: (() => void) | undefined;

    try {
      // Build prompt from conversation context
      const systemPrompt = context.systemPrompt
        ? `<system>\n${context.systemPrompt}\n</system>\n\n`
        : "";
      const conversation = buildGrokPrompt(context);
      const fullPrompt = systemPrompt + conversation;

      const integrationMode = options?.integrationMode ?? resolveGrokIntegrationMode();
      if (integrationMode === "acp") {
        diagnostics.debug("delegating grok provider stream to acp mode", () => ({
          modelId: model.id,
          provider: model.provider,
          messageCount: context.messages.length,
          hasSystemPrompt: Boolean(context.systemPrompt),
        }));
        const acpStream = streamViaGrokAcp(model, fullPrompt, {
          ...options,
          ...(options?.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
        });
        for await (const event of acpStream as AsyncIterable<AssistantMessageEvent>) {
          stream.push(event);
        }
        stream.end();
        return;
      }

      // Spawn grok subprocess with all advanced options
      const spawnOpts = buildSpawnOptions(model, options);
      diagnostics.debug("starting grok provider stream", () => ({
        modelId: model.id,
        provider: model.provider,
        messageCount: context.messages.length,
        hasSystemPrompt: Boolean(context.systemPrompt),
        integrationMode,
        spawnOptions: {
          ...spawnOpts,
          promptJson: spawnOpts.promptJson ? "<redacted>" : undefined,
          systemPromptOverride: spawnOpts.systemPromptOverride ? "<redacted>" : undefined,
        },
      }));
      proc = spawnGrok(fullPrompt, spawnOpts);
      registerProcess(proc);

      const getStderr = captureStderr(proc);

      // Create event bridge
      const bridge = createGrokEventBridge(stream, model);
      const output = bridge.getOutput();

      let streamEnded = false;
      const broken = false;
      let started = false;

      function ensureStarted(): void {
        if (started) return;
        started = true;
        stream.push({ type: "start", partial: output });
      }

      // Same chronological block sequencing as the ACP path: each contiguous
      // thought/text run gets its own tail block so deltas never target an
      // already-settled block (see src/content-blocks.ts).
      const blocks = createContentBlockSequencer({
        push: (event) => stream.push(event),
        output,
        ensureStarted,
      });
      const appendTextDelta = blocks.appendText;
      const appendThinkingDelta = blocks.appendThinking;
      const finishOpenBlocks = blocks.finish;

      function endStreamWithError(errMsg: string): void {
        if (streamEnded || broken) return;
        const diagnostic = classifyGrokFailure({ message: errMsg });
        const userMessage = formatGrokFailure(diagnostic);
        diagnostics.warn("ending grok stream with error", () => ({
          diagnostic: { ...diagnostic, stdout: undefined, stderr: undefined },
          modelId: model.id,
        }));
        streamEnded = true;
        finishOpenBlocks();
        const errorMessage = {
          ...output,
          content: output.content?.length
            ? output.content
            : [{ type: "text" as const, text: userMessage }],
          stopReason: "error" as const,
          errorMessage: userMessage,
        };
        stream.push({
          type: "error",
          reason: "error",
          error: errorMessage,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        stream.end();
      }

      // Inactivity timeout
      let inactivityTimer: ReturnType<typeof setTimeout> | undefined;

      function resetInactivityTimer(): void {
        if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          if (proc) forceKillProcess(proc);
          endStreamWithError(
            `Grok CLI subprocess timed out: no output for ${INACTIVITY_TIMEOUT_MS / 1000} seconds`,
          );
        }, INACTIVITY_TIMEOUT_MS);
      }

      // Abort signal handling
      if (options?.signal) {
        abortHandler = () => {
          if (proc) forceKillProcess(proc);
        };
        if (options.signal.aborted) {
          abortHandler();
          return;
        }
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      resetInactivityTimer();

      // Read NDJSON lines from stdout
      const rl = createInterface({
        input: proc.stdout!,
        crlfDelay: Infinity,
        terminal: false,
      });

      proc.on("error", (err: Error) => {
        if (broken) return;
        endStreamWithError(getStderr() || err.message);
      });

      proc.on("close", (code: number | null) => {
        clearTimeout(inactivityTimer);
        if (broken) return;
        if (code !== 0 && code !== null) {
          const stderr = getStderr();
          const message = stderr
            ? `Grok CLI exited with code ${code}: ${stderr.trim()}`
            : `Grok CLI exited unexpectedly with code ${code}`;
          endStreamWithError(message);
        }
      });

      rl.on("line", (line: string) => {
        if (broken) return;
        resetInactivityTimer();

        const msg = parseGrokLine(line);
        if (!msg) {
          diagnostics.trace("ignored non-json grok stream line", () => ({
            lineLength: line.length,
          }));
          return;
        }

        if (isStreamEvent(msg)) {
          started = true;
          bridge.handleStreamEvent(msg);
        } else if (isTextEvent(msg)) {
          appendTextDelta(msg.data ?? "");
        } else if (isThoughtEvent(msg)) {
          appendThinkingDelta(msg.data ?? "");
        } else if (isEndEvent(msg)) {
          clearTimeout(inactivityTimer);
          finishOpenBlocks();
          if (msg.requestId) output.responseId = msg.requestId;
          output.stopReason = msg.stopReason === "MaxTokens" ? "length" : "stop";
          if (proc) forceKillProcess(proc);
          rl.close();
        } else if (isResultEvent(msg)) {
          if (msg.subtype === "error") {
            endStreamWithError(msg.error ?? "Unknown error from Grok CLI");
          }
          clearTimeout(inactivityTimer);
          if (proc) forceKillProcess(proc);
          rl.close();
        } else if (isErrorEvent(msg)) {
          endStreamWithError(msg.message ?? msg.error ?? "Unknown error from Grok CLI");
          clearTimeout(inactivityTimer);
          if (proc) forceKillProcess(proc);
          rl.close();
        }
        // System events are silently ignored
      });

      // Wait for readline to close
      await new Promise<void>((resolve) => {
        rl.on("close", resolve);
      });

      // Push final done event
      if (!streamEnded) {
        finishOpenBlocks();
        const piToolCalls = (output.content || []).filter(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (c: any) => c.type === "toolCall",
        );
        const effectiveReason =
          output.stopReason === "toolUse" && piToolCalls.length === 0 ? "stop" : output.stopReason;

        streamEnded = true;
        stream.push({
          type: "done",
          reason:
            effectiveReason === "toolUse"
              ? "toolUse"
              : effectiveReason === "length"
                ? "length"
                : "stop",
          message: { ...output, stopReason: effectiveReason },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        stream.end();
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const diagnostic = classifyGrokFailure({ message });
      const userMessage = formatGrokFailure(diagnostic);
      diagnostics.error("grok provider stream failed before subprocess completion", () => ({
        diagnostic: { ...diagnostic, stdout: undefined, stderr: undefined },
        modelId: model.id,
      }));
      stream.push({
        type: "error",
        reason: "error",
        error: {
          role: "assistant",
          content: [{ type: "text" as const, text: userMessage }],
          api: "pi-grok-build",
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error",
          errorMessage: userMessage,
          timestamp: Date.now(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      stream.end();
    } finally {
      if (options?.signal && abortHandler) {
        options.signal.removeEventListener("abort", abortHandler);
      }
    }
  })();

  return stream;
}
