import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatGrokToolCall, summarizeToolInput } from "../../src/tool-activity.ts";

// Captured verbatim from grok 0.2.112 `session/update`.
const REAL_TOOL_CALL = {
  sessionUpdate: "tool_call",
  toolCallId: "call-afc20231-591a-4f3f-ac76-b442ab422184-0",
  title: "list_dir",
  rawInput: { target_directory: "/home/joe/code/zge-workspace/pi-grok-build" },
  _meta: {
    "x.ai/tool": {
      version: 1,
      name: "list_dir",
      kind: "list",
      namespace: "grok_build",
      label: "List Files",
      read_only: true,
    },
  },
};

describe("formatGrokToolCall", () => {
  it("renders a real grok tool call as one inert text line", () => {
    assert.equal(
      formatGrokToolCall(REAL_TOOL_CALL),
      "\n⚙ list_dir(target_directory: /home/joe/code/zge-workspace/pi-grok-build)\n",
    );
  });

  it("ignores updates that are not tool call announcements", () => {
    assert.equal(formatGrokToolCall(undefined), null);
    assert.equal(formatGrokToolCall({ sessionUpdate: "agent_message_chunk" }), null);
    assert.equal(
      formatGrokToolCall({ sessionUpdate: "tool_call_update", status: "completed" }),
      null,
    );
  });

  it("ignores a tool call with no resolvable name", () => {
    assert.equal(formatGrokToolCall({ sessionUpdate: "tool_call", rawInput: { a: 1 } }), null);
  });

  it("falls back to the title when x.ai metadata is absent", () => {
    assert.equal(
      formatGrokToolCall({ sessionUpdate: "tool_call", title: "web_search" }),
      "\n⚙ web_search\n",
    );
  });
});

describe("summarizeToolInput", () => {
  it("flattens object arguments to key: value pairs", () => {
    assert.equal(summarizeToolInput({ file: "a.ts", limit: 40 }), "file: a.ts, limit: 40");
  });

  it("collapses whitespace so a call never spans lines", () => {
    assert.equal(summarizeToolInput({ q: "line one\n  line two" }), "q: line one line two");
  });

  it("truncates long arguments", () => {
    const out = summarizeToolInput({ body: "x".repeat(500) });
    assert.ok(out.length <= 160, `expected <=160 chars, got ${out.length}`);
    assert.ok(out.endsWith("…"));
  });

  it("handles empty and primitive inputs", () => {
    assert.equal(summarizeToolInput(undefined), "");
    assert.equal(summarizeToolInput(null), "");
    assert.equal(summarizeToolInput("plain"), "plain");
  });
});
