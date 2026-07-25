import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
} from "@earendil-works/pi-ai";
import spawn from "cross-spawn";
import { createContentBlockSequencer } from "./content-blocks.ts";
import { classifyGrokFailure, createDiagnostics, formatGrokFailure } from "./diagnostics.ts";
import { captureStderr, forceKillProcess, registerProcess } from "./grok-runner.ts";
import { GROK_DEFAULT_INTEGRATION_MODE } from "./model-metadata.ts";
import type { GrokReasoningEffort, GrokUsage } from "./types.ts";

export type GrokIntegrationMode = "jsonl" | "acp";

const INACTIVITY_TIMEOUT_MS = 180_000;
const diagnostics = createDiagnostics("acp-mode");

interface JsonRpcMessage {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown };
}

interface AcpInitializeResult {
  authMethods?: Array<{ id?: string; name?: string }>;
}

interface AcpSessionResult {
  sessionId?: string;
}

interface AcpPromptResult {
  stopReason?: string;
  _meta?: {
    requestId?: string;
    promptId?: string;
    inputTokens?: number;
    outputTokens?: number;
    cachedReadTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
    modelId?: string;
  };
}

interface AcpStreamOptions extends SimpleStreamOptions {
  cwd?: string;
  reasoningEffort?: GrokReasoningEffort | undefined;
}

export function parseGrokIntegrationMode(value: string | undefined): GrokIntegrationMode {
  if (value === undefined || value.trim() === "") return GROK_DEFAULT_INTEGRATION_MODE;
  const normalized = value.trim().toLowerCase();
  if (normalized === "jsonl" || normalized === "acp") return normalized;
  throw new Error(
    `Invalid Grok integration mode '${value}'. Use PI_GROK_BUILD_MODE=jsonl or PI_GROK_BUILD_MODE=acp.`,
  );
}

export function resolveGrokIntegrationMode(
  env: Partial<
    Record<"PI_GROK_BUILD_MODE" | "PI_GROK_BUILD_INTEGRATION_MODE", string | undefined>
  > = process.env,
): GrokIntegrationMode {
  return parseGrokIntegrationMode(env.PI_GROK_BUILD_MODE ?? env.PI_GROK_BUILD_INTEGRATION_MODE);
}

export function buildGrokAcpArgs(options: {
  modelId?: string;
  reasoningEffort?: GrokReasoningEffort;
  alwaysApprove?: boolean;
}): string[] {
  const args = ["agent", "--no-leader"];
  if (options.alwaysApprove !== false) args.push("--always-approve");
  if (options.modelId) args.push("--model", options.modelId);
  if (options.reasoningEffort) args.push("--reasoning-effort", options.reasoningEffort);
  args.push("stdio");
  return args;
}

class AcpJsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private readonly notifications = new Set<(message: JsonRpcMessage) => void>();

  constructor(private readonly proc: ChildProcess) {
    const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity, terminal: false });
    rl.on("line", (line) => this.handleLine(line));
    proc.on("error", (err) => this.rejectAll(err));
    proc.on("close", (code) => {
      if (this.pending.size === 0) return;
      this.rejectAll(new Error(`Grok ACP subprocess exited before responding (code ${code})`));
    });
  }

  onNotification(listener: (message: JsonRpcMessage) => void): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.proc.stdin?.write(payload);
    return promise;
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      diagnostics.trace("ignored non-json acp line", () => ({ lineLength: line.length }));
      return;
    }

    if (typeof message.id === "number" && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(message.error.message ?? `ACP request failed: ${message.error.code}`),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    for (const listener of this.notifications) listener(message);
  }

  private rejectAll(err: Error): void {
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }
}

function chooseAuthMethod(initializeResult: AcpInitializeResult): string {
  const ids = new Set(
    (initializeResult.authMethods ?? []).map((method) => method.id).filter(Boolean),
  );
  if (ids.has("cached_token")) return "cached_token";
  if (process.env.XAI_API_KEY && ids.has("xai.api_key")) return "xai.api_key";
  throw new Error(
    `Grok ACP authentication is unavailable. Run \`grok\` to authenticate locally. Offered methods: ${
      [...ids].join(", ") || "none"
    }`,
  );
}

function acpStopReasonToPi(reason: string | undefined): StopReason {
  if (reason === "max_tokens" || reason === "maxTokens") return "length";
  return "stop";
}

function usageFromAcp(meta: AcpPromptResult["_meta"]): GrokUsage {
  return {
    input_tokens: meta?.inputTokens ?? 0,
    output_tokens: meta?.outputTokens ?? 0,
    cache_read_input_tokens: meta?.cachedReadTokens ?? 0,
  };
}

export function streamViaGrokAcp(
  model: Model<Api>,
  prompt: string,
  options?: AcpStreamOptions,
): AssistantMessageEventStream {
  // @ts-expect-error — pi-ai exports AssistantMessageEventStream as export type.
  const stream = new AssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
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
      stopReason: "stop",
      timestamp: Date.now(),
    };

    let proc: ChildProcess | undefined;
    let cleanupNotifications: (() => void) | undefined;
    let streamEnded = false;
    let started = false;
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;

    const ensureStarted = (): void => {
      if (started) return;
      started = true;
      stream.push({ type: "start", partial: output });
    };

    // Grok's agent loop interleaves reasoning and answer runs across tool calls.
    // The sequencer turns each run into its own tail block so deltas never land
    // on an earlier block (see src/content-blocks.ts).
    const blocks = createContentBlockSequencer({
      push: (event) => stream.push(event),
      output,
      ensureStarted,
    });
    const appendTextDelta = blocks.appendText;
    const appendThinkingDelta = blocks.appendThinking;
    const finishOpenBlocks = blocks.finish;

    const endWithError = (message: string): void => {
      if (streamEnded) return;
      const diagnostic = classifyGrokFailure({ message });
      const userMessage = formatGrokFailure(diagnostic);
      diagnostics.warn("ending grok acp stream with error", () => ({ diagnostic }));
      streamEnded = true;
      finishOpenBlocks();
      const event: AssistantMessageEvent = {
        type: "error",
        reason: "error",
        error: {
          ...output,
          content: output.content.length ? output.content : [{ type: "text", text: userMessage }],
          stopReason: "error",
          errorMessage: userMessage,
        },
      };
      stream.push(event);
      stream.end();
    };

    const resetInactivityTimer = (): void => {
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        if (proc) forceKillProcess(proc);
        endWithError(
          `Grok ACP subprocess timed out: no output for ${INACTIVITY_TIMEOUT_MS / 1000} seconds`,
        );
      }, INACTIVITY_TIMEOUT_MS);
    };

    try {
      const binary = "grok";
      const args = buildGrokAcpArgs({
        modelId: model.id,
        ...(options?.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
        alwaysApprove: true,
      });
      diagnostics.debug("spawning grok acp cli", () => ({
        binary,
        args,
        cwd: options?.cwd ?? process.cwd(),
      }));
      proc = spawn(binary, args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: options?.cwd ?? process.cwd(),
        env: process.env,
      }) as ChildProcess;
      registerProcess(proc);
      captureStderr(proc);
      const client = new AcpJsonRpcClient(proc);
      cleanupNotifications = client.onNotification((message) => {
        resetInactivityTimer();
        if (message.method !== "session/update") return;
        const params = message.params as {
          update?: { sessionUpdate?: string; content?: { text?: string } };
        };
        const update = params.update;
        if (update?.sessionUpdate === "agent_message_chunk")
          appendTextDelta(update.content?.text ?? "");
        if (update?.sessionUpdate === "agent_thought_chunk")
          appendThinkingDelta(update.content?.text ?? "");
      });

      if (options?.signal?.aborted) {
        forceKillProcess(proc);
        endWithError("Grok ACP request was aborted before it started.");
        return;
      }
      const abortHandler = (): void => {
        if (proc) forceKillProcess(proc);
      };
      options?.signal?.addEventListener("abort", abortHandler, { once: true });
      try {
        resetInactivityTimer();
        const initializeResult = (await client.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "pi-grok-build", version: "0.1.1" },
        })) as AcpInitializeResult;
        const methodId = chooseAuthMethod(initializeResult);
        await client.request("authenticate", { methodId });
        const sessionResult = (await client.request("session/new", {
          cwd: options?.cwd ?? process.cwd(),
          mcpServers: [],
        })) as AcpSessionResult;
        if (!sessionResult.sessionId) throw new Error("Grok ACP did not return a session id.");
        const promptResult = (await client.request("session/prompt", {
          sessionId: sessionResult.sessionId,
          prompt: [{ type: "text", text: prompt }],
        })) as AcpPromptResult;

        clearTimeout(inactivityTimer);
        finishOpenBlocks();
        const usage = usageFromAcp(promptResult._meta);
        output.usage = {
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          cacheWrite: 0,
          totalTokens:
            promptResult._meta?.totalTokens ??
            (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        const doneReason = acpStopReasonToPi(promptResult.stopReason);
        output.stopReason = doneReason;
        const responseId = promptResult._meta?.requestId ?? promptResult._meta?.promptId;
        if (responseId) output.responseId = responseId;

        streamEnded = true;
        const event: AssistantMessageEvent = {
          type: "done",
          reason: doneReason === "length" || doneReason === "toolUse" ? doneReason : "stop",
          message: output,
        };
        stream.push(event);
        stream.end();
      } finally {
        options?.signal?.removeEventListener("abort", abortHandler);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      endWithError(message);
    } finally {
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      cleanupNotifications?.();
      if (proc) forceKillProcess(proc);
    }
  })();

  return stream;
}
