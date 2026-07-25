import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createContentBlockSequencer } from "../../src/content-blocks.ts";

interface CapturedEvent {
  type: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
}

function harness() {
  const events: CapturedEvent[] = [];
  const output = { content: [] as Array<Record<string, unknown>> };
  let startCount = 0;
  const sequencer = createContentBlockSequencer({
    push: (event) => events.push(event as CapturedEvent),
    output: output as unknown as Parameters<typeof createContentBlockSequencer>[0]["output"],
    ensureStarted: () => {
      startCount++;
    },
  });
  return { events, output, sequencer, startedTimes: () => startCount };
}

/**
 * omp's assistant-message renderer only permits the LAST content block to
 * mutate in place; a delta into an earlier block tears down and rebuilds the
 * whole message (packages/coding-agent/src/modes/components/assistant-message.ts).
 * Every delta we emit must therefore target the tail block.
 */
function assertAllDeltasTargetTail(events: CapturedEvent[]): void {
  let blockCount = 0;
  for (const event of events) {
    if (event.type === "text_start" || event.type === "thinking_start") blockCount++;
    if (event.type === "text_delta" || event.type === "thinking_delta") {
      assert.equal(
        event.contentIndex,
        blockCount - 1,
        `${event.type} targeted block ${event.contentIndex} but the tail block is ${blockCount - 1}`,
      );
    }
  }
}

describe("createContentBlockSequencer", () => {
  it("streams a single thinking run then a single text run", () => {
    const { events, output, sequencer } = harness();
    sequencer.appendThinking("think ");
    sequencer.appendThinking("more");
    sequencer.appendText("answer");
    sequencer.finish();

    assert.deepEqual(
      events.map((e) => e.type),
      [
        "thinking_start",
        "thinking_delta",
        "thinking_delta",
        "thinking_end",
        "text_start",
        "text_delta",
        "text_end",
      ],
    );
    assert.deepEqual(output.content, [
      { type: "thinking", thinking: "think more", thinkingSignature: "" },
      { type: "text", text: "answer" },
    ]);
    assertAllDeltasTargetTail(events);
  });

  it("opens a NEW block when grok interleaves a second thought run after text", () => {
    // Real grok 0.2.112 ACP shape: thought -> message -> tool calls -> thought -> message.
    const { events, output, sequencer } = harness();
    sequencer.appendThinking("first thought");
    sequencer.appendText("partial answer");
    sequencer.appendThinking("second thought");
    sequencer.appendText("final answer");
    sequencer.finish();

    assert.deepEqual(
      events.map((e) => e.type),
      [
        "thinking_start",
        "thinking_delta",
        "thinking_end",
        "text_start",
        "text_delta",
        "text_end",
        "thinking_start",
        "thinking_delta",
        "thinking_end",
        "text_start",
        "text_delta",
        "text_end",
      ],
    );
    // Four chronological blocks, not two reused ones.
    assert.equal(output.content.length, 4);
    assert.deepEqual(
      output.content.map((b) => b.type),
      ["thinking", "text", "thinking", "text"],
    );
    // The second thought must NOT be merged into the first thinking block.
    assert.equal(output.content[0]!.thinking, "first thought");
    assert.equal(output.content[2]!.thinking, "second thought");
    assertAllDeltasTargetTail(events);
  });

  it("keeps every delta on the tail block across many alternations", () => {
    const { events, sequencer } = harness();
    for (let i = 0; i < 5; i++) {
      sequencer.appendThinking(`t${i}`);
      sequencer.appendText(`m${i}`);
    }
    sequencer.finish();
    assertAllDeltasTargetTail(events);
  });

  it("closes each block exactly once and reports its full content", () => {
    const { events, sequencer } = harness();
    sequencer.appendThinking("aa");
    sequencer.appendText("bb");
    sequencer.finish();

    const thinkingEnd = events.find((e) => e.type === "thinking_end");
    const textEnd = events.find((e) => e.type === "text_end");
    assert.equal(thinkingEnd?.content, "aa");
    assert.equal(textEnd?.content, "bb");
    assert.equal(events.filter((e) => e.type === "thinking_end").length, 1);
    assert.equal(events.filter((e) => e.type === "text_end").length, 1);
  });

  it("ignores empty deltas and starts the stream only on real content", () => {
    const { events, output, sequencer, startedTimes } = harness();
    sequencer.appendThinking("");
    sequencer.appendText("");
    assert.equal(events.length, 0, "empty deltas must not open a block");
    assert.equal(output.content.length, 0);
    assert.equal(startedTimes(), 0, "empty deltas must not start the stream");

    // Callers supply an idempotent ensureStarted; the sequencer only has to
    // call it before emitting real content.
    sequencer.appendText("real");
    assert.ok(startedTimes() >= 1);
    assert.deepEqual(
      events.map((e) => e.type),
      ["text_start", "text_delta"],
    );
  });

  it("is idempotent on finish so error and done paths can both call it", () => {
    const { events, sequencer } = harness();
    sequencer.appendText("x");
    sequencer.finish();
    sequencer.finish();
    assert.equal(events.filter((e) => e.type === "text_end").length, 1);
  });
});
