/**
 * Rendering for Grok's own tool calls.
 *
 * Grok's ACP agent executes its tools itself (its built-ins plus whatever MCP
 * servers it loads). omp therefore never sees a tool call and the turn looks
 * like the model "can't call tools", even while Grok is busy reading files.
 *
 * We deliberately do NOT surface these as Pi `toolCall` content blocks: omp's
 * agent loop runs any toolCall block whose message stops with `toolUse` OR
 * `stop` (packages/agent/src/agent-loop.ts), so emitting them would make omp
 * re-execute work Grok already did, under tool names omp does not have.
 *
 * Instead each call is announced as a compact line of assistant text, which is
 * inert and always visible in the transcript.
 */

/** Grok's `session/update` tool_call payload (fields we rely on). */
export interface GrokToolCallUpdate {
  sessionUpdate?: string;
  toolCallId?: string;
  title?: string;
  status?: string;
  rawInput?: unknown;
  _meta?: {
    "x.ai/tool"?: { name?: string; label?: string; kind?: string; read_only?: boolean };
  };
}

const MAX_ARGS_LENGTH = 160;

/** Compact single-line rendering of a tool call's arguments. */
export function summarizeToolInput(rawInput: unknown): string {
  if (rawInput === undefined || rawInput === null) return "";
  if (typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return truncate(String(rawInput));
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(rawInput as Record<string, unknown>)) {
    const rendered =
      typeof value === "string"
        ? value
        : value === null || value === undefined
          ? ""
          : JSON.stringify(value);
    parts.push(`${key}: ${rendered}`);
  }
  return truncate(parts.join(", "));
}

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_ARGS_LENGTH ? `${flat.slice(0, MAX_ARGS_LENGTH - 1)}…` : flat;
}

/**
 * Render a `tool_call` update as an inert assistant-text line, or null when the
 * update is not a tool call announcement we should show.
 */
export function formatGrokToolCall(update: GrokToolCallUpdate | undefined): string | null {
  if (!update || update.sessionUpdate !== "tool_call") return null;
  const meta = update._meta?.["x.ai/tool"];
  const name = meta?.name ?? update.title;
  if (!name) return null;
  const args = summarizeToolInput(update.rawInput);
  return args ? `\n⚙ ${name}(${args})\n` : `\n⚙ ${name}\n`;
}
