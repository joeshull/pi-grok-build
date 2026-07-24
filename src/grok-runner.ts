/**
 * Process manager for spawning and managing Grok Build CLI subprocesses.
 *
 * Handles the full subprocess lifecycle: spawn with correct CLI flags,
 * write prompts via stdin (ACP mode), capture stdout/stderr, force-kill,
 * and startup validation for CLI presence and authentication.
 */

import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import spawn from "cross-spawn";
import {
  classifyGrokFailure,
  createDiagnostics,
  GrokCliError,
  redactGrokArgs,
} from "./diagnostics.ts";
import type { GrokModelDescriptor, GrokRunResult, GrokSpawnOptions } from "./types.ts";

const GROK_BINARY = "grok";
const MAX_GROK_OUTPUT = 500_000;
const DEFAULT_GROK_TIMEOUT = 120_000;
const require = createRequire(import.meta.url);

type EffectRuntime = {
  try(options: { try: () => string; catch: (error: unknown) => GrokCliError }): any;
  runSync(effect: any): string;
};

function loadEffect(): EffectRuntime {
  return require("effect").Effect as EffectRuntime;
}
const diagnostics = createDiagnostics("grok-runner");

type GrokCommandError = {
  stdout?: Buffer | string;
  stderr?: Buffer | string;
  status?: number | null;
  message?: string;
};

function grokCommandFailure(
  args: string[],
  execErr: GrokCommandError,
  maxOutput = MAX_GROK_OUTPUT,
): GrokRunResult {
  const stdout =
    typeof execErr.stdout === "string" ? execErr.stdout : (execErr.stdout?.toString() ?? "");
  const stderr = execErr.stderr?.toString() ?? execErr.message ?? "Unknown error";
  const diagnostic = classifyGrokFailure({
    message: execErr.message,
    stderr,
    stdout,
    exitCode: execErr.status ?? 1,
  });

  diagnostics.warn("grok command failed", () => ({
    args: redactGrokArgs(args),
    diagnostic: { ...diagnostic, stdout: undefined, stderr: undefined },
  }));

  return {
    ok: false,
    exitCode: execErr.status ?? 1,
    stdout: stdout.slice(0, maxOutput),
    stderr: diagnostic.message.slice(0, maxOutput),
    truncated: stdout.length > maxOutput || stderr.length > maxOutput,
  };
}

function toMissingGrokCliError(err: unknown): GrokCliError {
  const message = err instanceof Error ? err.message : String(err);
  const diagnostic = classifyGrokFailure({ message });
  diagnostics.debug("grok binary detection failed", () => ({ diagnostic }));
  return new GrokCliError(
    {
      ...diagnostic,
      message: `${diagnostic.message} Original error: ${message}`,
    },
    { cause: err },
  );
}

/** Detect the installed grok binary on PATH only, modeled as a typed Effect. */
export function detectGrokBinaryEffect(): ReturnType<EffectRuntime["try"]> {
  const Effect = loadEffect();
  return Effect.try({
    try: () => {
      execFileSync(GROK_BINARY, ["--version"], { stdio: "pipe", timeout: 5000 });
      return GROK_BINARY;
    },
    catch: toMissingGrokCliError,
  });
}

/** Detect the installed grok binary on PATH only. */
export function detectGrokBinary(): string {
  const Effect = loadEffect();
  return Effect.runSync(detectGrokBinaryEffect());
}

/**
 * Build the argument array for `grok -p` from GrokSpawnOptions.
 * Centralizes flag mapping so spawnGrok and tests share the same logic.
 */
export function buildGrokArgs(prompt: string, options: GrokSpawnOptions): string[] {
  const args: string[] = ["-p", prompt, "--output-format", "streaming-json"];

  if (options.modelId) {
    args.push("--model", options.modelId);
  }

  if (options.sessionId) {
    args.push("--session-id", options.sessionId);
  }

  if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  }

  if (options.continueSession) {
    args.push("--continue");
  }

  if (options.workingDirectory) {
    args.push("--cwd", options.workingDirectory);
  }

  if (options.alwaysApprove) {
    args.push("--always-approve");
  }

  if (options.effort) {
    args.push("--effort", options.effort);
  }

  if (options.maxTurns != null) {
    args.push("--max-turns", String(options.maxTurns));
  }

  if (options.reasoningEffort) {
    args.push("--reasoning-effort", options.reasoningEffort);
  }

  if (options.check) {
    args.push("--check");
  }

  if (options.verbatim) {
    args.push("--verbatim");
  }

  if (options.disableWebSearch) {
    args.push("--disable-web-search");
  }

  if (options.noSubagents) {
    args.push("--no-subagents");
  }

  if (options.noPlan) {
    args.push("--no-plan");
  }

  if (options.noMemory) {
    args.push("--no-memory");
  }

  if (options.experimentalMemory) {
    args.push("--experimental-memory");
  }

  if (options.permissionMode) {
    args.push("--permission-mode", options.permissionMode);
  }

  if (options.rules) {
    args.push("--rules", options.rules);
  }

  if (options.systemPromptOverride) {
    args.push("--system-prompt-override", options.systemPromptOverride);
  }

  if (options.tools) {
    args.push("--tools", options.tools);
  }

  if (options.disallowedTools) {
    args.push("--disallowed-tools", options.disallowedTools);
  }

  if (options.allowRules) {
    for (const rule of options.allowRules) {
      args.push("--allow", rule);
    }
  }

  if (options.denyRules) {
    for (const rule of options.denyRules) {
      args.push("--deny", rule);
    }
  }

  if (options.sandbox) {
    args.push("--sandbox", options.sandbox);
  }

  // 0.1.216 additions
  if (options.restoreCode) {
    args.push("--restore-code");
  }

  if (options.oauth) {
    args.push("--oauth");
  }

  if (options.promptFile) {
    args.push("--prompt-file", options.promptFile);
  }

  if (options.promptJson) {
    args.push("--prompt-json", options.promptJson);
  }

  return args;
}

/**
 * Spawn a Grok CLI subprocess in one-shot headless mode.
 *
 * Uses `grok -p "prompt" --output-format streaming-json` to send a prompt
 * and receive streaming JSON events on stdout.
 *
 * @param prompt - The prompt text to send
 * @param options - Optional cwd, AbortSignal, model, session settings, and new headless flags
 * @returns The spawned ChildProcess with piped stdin/stdout/stderr
 */
export function spawnGrok(prompt: string, options: GrokSpawnOptions = {}): ChildProcess {
  const binary = GROK_BINARY;
  const args = buildGrokArgs(prompt, options);

  diagnostics.debug("spawning grok cli", () => ({
    binary,
    args: redactGrokArgs(args),
    cwd: options.cwd ?? process.cwd(),
    modelId: options.modelId,
  }));

  const proc = spawn(binary, args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: options.cwd ?? process.cwd(),
    env: process.env,
  });

  return proc as ChildProcess;
}

/**
 * Validate that the Grok CLI is installed and on PATH.
 * Throws with install instructions if not found.
 */
export function validateGrokPresence(): void {
  detectGrokBinary();
}

/**
 * Check if Grok CLI is authenticated.
 * Returns true/false — does not throw.
 *
 * Uses `grok models` as the auth probe and checks stdout for the string
 * "not authenticated". `grok --version` does not require auth, so we
 * prefer a command that actually exercises auth.
 */
export function validateGrokAuth(): boolean {
  try {
    const binary = GROK_BINARY;
    const stdout = execFileSync(binary, ["models"], {
      stdio: "pipe",
      timeout: 15_000,
      encoding: "utf-8",
    });
    if (/not authenticated/i.test(stdout)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the Grok CLI version string.
 * Returns "unknown" if not installed or command fails.
 */
export function getGrokVersion(): string {
  try {
    const binary = detectGrokBinary();
    return execFileSync(binary, ["--version"], {
      stdio: "pipe",
      timeout: 5000,
      encoding: "utf-8",
    }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Run a raw Grok CLI command and capture the output.
 * Used by the grok_run tool for arbitrary grok commands.
 *
 * @param args - Arguments to pass to grok
 * @param options - Optional cwd and timeout
 * @returns Structured result with stdout, stderr, exit code
 */
export function runGrokCommand(
  args: string[],
  options: { cwd?: string; timeout?: number } = {},
): GrokRunResult {
  const maxOutput = MAX_GROK_OUTPUT;

  try {
    const binary = GROK_BINARY;
    diagnostics.debug("running grok command", () => ({
      args: redactGrokArgs(args),
      cwd: options.cwd ?? process.cwd(),
      timeout: options.timeout ?? DEFAULT_GROK_TIMEOUT,
    }));
    const stdout = execFileSync(binary, args, {
      cwd: options.cwd ?? process.cwd(),
      timeout: options.timeout ?? DEFAULT_GROK_TIMEOUT,
      maxBuffer: maxOutput,
      stdio: "pipe",
      encoding: "utf-8",
    });

    const text = stdout.toString();
    return {
      ok: true,
      exitCode: 0,
      stdout: text.length > maxOutput ? text.slice(0, maxOutput) : text,
      stderr: "",
      truncated: text.length > maxOutput,
    };
  } catch (err: unknown) {
    return grokCommandFailure(args, err as GrokCommandError, maxOutput);
  }
}

/**
 * Run a raw Grok CLI command without blocking the extension's event loop.
 *
 * The child process is tracked for teardown and resolves with the same
 * structured result as the synchronous runner.
 */
export function runGrokCommandAsync(
  args: string[],
  options: { cwd?: string; timeout?: number; detach?: boolean } = {},
): Promise<GrokRunResult> {
  const maxOutput = MAX_GROK_OUTPUT;
  const timeout = options.timeout ?? DEFAULT_GROK_TIMEOUT;
  const detach = options.detach ?? false;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const append = (target: "stdout" | "stderr", chunk: Buffer | string): void => {
      const text = chunk.toString();
      const current = target === "stdout" ? stdout : stderr;
      const remaining = maxOutput - current.length;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const next = current + text.slice(0, remaining);
      if (target === "stdout") stdout = next;
      else stderr = next;
      if (text.length > remaining) truncated = true;
    };

    const finish = (result: GrokRunResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    diagnostics.debug("running grok command asynchronously", () => ({
      args: redactGrokArgs(args),
      cwd: options.cwd ?? process.cwd(),
      timeout,
    }));

    let proc: ChildProcess;
    try {
      proc = spawn(GROK_BINARY, args, {
        cwd: options.cwd ?? process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      }) as ChildProcess;
    } catch (err: unknown) {
      finish(grokCommandFailure(args, err as GrokCommandError, maxOutput));
      return;
    }

    registerProcess(proc);
    if (detach) {
      // The startup probe is diagnostic-only; never keep Pi startup alive for it.
      proc.unref();
    }
    proc.stdout?.on("data", (chunk: Buffer | string) => append("stdout", chunk));
    proc.stderr?.on("data", (chunk: Buffer | string) => append("stderr", chunk));
    if (detach) {
      (proc.stdout as unknown as { unref?: () => void } | null)?.unref?.();
      (proc.stderr as unknown as { unref?: () => void } | null)?.unref?.();
    }
    proc.once("error", (err) => {
      finish(
        grokCommandFailure(args, { message: err.message, stdout, stderr, status: null }, maxOutput),
      );
    });
    proc.once("close", (code, signal) => {
      if (code === 0) {
        finish({ ok: true, exitCode: 0, stdout, stderr, truncated });
        return;
      }
      finish(
        grokCommandFailure(
          args,
          {
            ...(signal ? { message: `grok command terminated by ${signal}` } : {}),
            stdout,
            stderr,
            status: code,
          },
          maxOutput,
        ),
      );
    });
    timer = setTimeout(() => {
      proc.kill("SIGKILL");
      finish(
        grokCommandFailure(
          args,
          { message: `grok command timed out after ${timeout}ms`, stdout, stderr, status: null },
          maxOutput,
        ),
      );
    }, timeout);
    if (detach) timer.unref?.();
  });
}

/**
 * Run `grok inspect` and return the parsed config.
 * Grok inspect shows discovered config, instructions, skills, plugins, hooks, MCP servers.
 */
export function runGrokInspect(options: { cwd?: string } = {}): GrokRunResult {
  return runGrokCommand(["inspect"], options);
}

/**
 * Run `grok models` and return available models.
 */
export function runGrokModels(options: { cwd?: string } = {}): GrokRunResult {
  return runGrokCommand(["models"], options);
}

/**
 * Run `grok models` without blocking the extension event loop.
 */
export function runGrokModelsAsync(
  options: { cwd?: string; detach?: boolean } = {},
): Promise<GrokRunResult> {
  return runGrokCommandAsync(["models"], options);
}

/**
 * Run `grok sessions` and return session list.
 */
export function runGrokSessions(options: { cwd?: string } = {}): GrokRunResult {
  return runGrokCommand(["sessions"], options);
}

/**
 * Run `grok memory` and return memory entries.
 */
export function runGrokMemory(options: { cwd?: string } = {}): GrokRunResult {
  return runGrokCommand(["memory"], options);
}

/**
 * Run `grok share` for the current or specified session.
 */
export function runGrokShare(sessionId?: string, options: { cwd?: string } = {}): GrokRunResult {
  const args = sessionId ? ["share", sessionId] : ["share"];
  return runGrokCommand(args, options);
}

/**
 * Run `grok trace` to export session trace data.
 */
export function runGrokTrace(options: { cwd?: string } = {}): GrokRunResult {
  return runGrokCommand(["trace"], options);
}

/**
 * Parse the JSON output of `grok models --output-format json` (or plain) into
 * a typed array of model descriptors.
 *
 * Falls back to regex extraction if JSON parsing fails.
 */
export function parseGrokModelsOutput(stdout: string): GrokModelDescriptor[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  // Try JSON first
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((m) => m && typeof m.id === "string")
        .map((m) => ({ id: m.id, name: m.name ?? m.id }));
    }
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.models)) {
      return parsed.models
        .filter((m: Record<string, unknown>) => m && typeof m.id === "string")
        .map((m: Record<string, unknown>) => ({
          id: String(m.id),
          name: String(m.name ?? m.id),
        }));
    }
  } catch {
    // Fall through to regex extraction
  }

  // Plain-text fallback: handles grok models output like:
  //   * grok-build (default)
  //   - kimi-k2p6-turbo-firepass
  const models: GrokModelDescriptor[] = [];
  const seen = new Set<string>();
  for (const line of trimmed.split("\n")) {
    // Skip headers, empty lines, and auth notices
    if (
      !line.trim() ||
      line.includes(":") ||
      /not authenticated/i.test(line) ||
      /^\s*you are logged in\b/i.test(line)
    ) {
      continue;
    }
    // Match bullet-prefixed model lines: * model-id (optional meta)
    // or simple indented lines:   model-id   Display Name
    const bulletMatch = line.match(/^[\s*-]+([a-z0-9._-]+)(?:\s+\(([^)]+)\))?\s*$/i);
    if (bulletMatch) {
      const id = bulletMatch[1]!;
      const meta = bulletMatch[2];
      const name = meta && meta !== "default" ? `${id} (${meta})` : id;
      if (!seen.has(id)) {
        seen.add(id);
        models.push({ id, name });
      }
      continue;
    }
    // Fallback: tabular/space-separated lines
    const tabMatch = line.match(/^\s*([a-z0-9._-]+)\s+(.*?)\s*$/i);
    if (tabMatch) {
      const id = tabMatch[1]!;
      const name = tabMatch[2]!;
      if (!seen.has(id)) {
        seen.add(id);
        models.push({ id, name: name || id });
      }
    }
  }
  return models;
}

/** Registry of active subprocesses for cleanup on teardown. */
const activeProcesses = new Set<ChildProcess>();

/**
 * Register a subprocess in the global process registry.
 * Auto-removed when the process exits.
 */
export function registerProcess(proc: ChildProcess): void {
  activeProcesses.add(proc);
  proc.on("exit", () => activeProcesses.delete(proc));
}

/**
 * Force-kill a subprocess via SIGKILL (no-op if already dead).
 */
export function forceKillProcess(proc: ChildProcess): void {
  if (proc.killed || proc.exitCode !== null) return;
  proc.kill("SIGKILL");
}

/**
 * Force-kill all registered subprocesses.
 */
export function killAllProcesses(): void {
  for (const proc of activeProcesses) {
    forceKillProcess(proc);
  }
  activeProcesses.clear();
}

/**
 * Attach stderr listener and accumulate output.
 * Returns a function that returns the accumulated stderr string.
 */
export function captureStderr(proc: ChildProcess): () => string {
  let buffer = "";
  proc.stderr?.on("data", (data: Buffer) => {
    buffer += data.toString();
  });
  return () => buffer;
}
