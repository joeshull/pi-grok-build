/**
 * Chronological content-block sequencer for Pi assistant streams.
 *
 * Pi/omp consumers require that only the LAST content block mutates while a
 * message streams. omp's renderer states the invariant directly: a delta into
 * an earlier block invalidates rows the settled walk already declared final, so
 * it abandons its fast path and tears down/rebuilds the whole message
 * (`packages/coding-agent/src/modes/components/assistant-message.ts`). Doing
 * that once per chunk makes already-rendered text visibly disappear and
 * reappear, and makes streaming slow.
 *
 * Grok's ACP agent loop interleaves reasoning and answer runs within a single
 * prompt (thought -> message -> tool calls -> thought -> message), so a bridge
 * that keeps one sticky thinking block and one sticky text block per turn will
 * write into a stale, non-tail block every time reasoning resumes.
 *
 * This sequencer instead mirrors the reference providers (e.g. pi-ai's
 * Anthropic provider): each contiguous run of one kind becomes its own block,
 * closed before the next block opens, so every delta targets the tail.
 */

import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";

export type ContentBlockKind = "text" | "thinking";

export interface ContentBlockSequencerOptions {
  /** Pi stream to push assistant message events into. */
  push: (event: AssistantMessageEvent) => void;
  /** The partial assistant message accumulated for this turn. */
  output: AssistantMessage;
  /** Emits the one-time `start` event on first real content. */
  ensureStarted: () => void;
}

export interface ContentBlockSequencer {
  appendText(delta: string): void;
  appendThinking(delta: string): void;
  /** Close any open block. Safe to call more than once. */
  finish(): void;
}

export function createContentBlockSequencer(
  options: ContentBlockSequencerOptions,
): ContentBlockSequencer {
  const { push, output, ensureStarted } = options;

  let openKind: ContentBlockKind | undefined;
  let openIndex: number | undefined;

  function closeOpenBlock(): void {
    if (openKind === undefined || openIndex === undefined) return;
    const block = output.content[openIndex];
    if (openKind === "thinking" && block?.type === "thinking") {
      push({
        type: "thinking_end",
        contentIndex: openIndex,
        content: block.thinking,
        partial: output,
      });
    } else if (openKind === "text" && block?.type === "text") {
      push({ type: "text_end", contentIndex: openIndex, content: block.text, partial: output });
    }
    openKind = undefined;
    openIndex = undefined;
  }

  function openBlock(kind: ContentBlockKind): void {
    openIndex = output.content.length;
    openKind = kind;
    if (kind === "thinking") {
      output.content.push({ type: "thinking", thinking: "", thinkingSignature: "" });
      push({ type: "thinking_start", contentIndex: openIndex, partial: output });
    } else {
      output.content.push({ type: "text", text: "" });
      push({ type: "text_start", contentIndex: openIndex, partial: output });
    }
  }

  function append(kind: ContentBlockKind, delta: string): void {
    if (!delta) return;
    ensureStarted();
    // A kind change ends the current run: close it, then open a fresh tail block.
    if (openKind !== kind) {
      closeOpenBlock();
      openBlock(kind);
    }
    const index = openIndex!;
    const block = output.content[index];
    if (kind === "thinking" && block?.type === "thinking") {
      block.thinking += delta;
      push({ type: "thinking_delta", contentIndex: index, delta, partial: output });
    } else if (kind === "text" && block?.type === "text") {
      block.text += delta;
      push({ type: "text_delta", contentIndex: index, delta, partial: output });
    }
  }

  return {
    appendText: (delta: string) => append("text", delta),
    appendThinking: (delta: string) => append("thinking", delta),
    finish: closeOpenBlock,
  };
}
