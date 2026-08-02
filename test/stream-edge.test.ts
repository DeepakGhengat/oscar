// StreamTranslator state machine: block transitions, multiple tool calls,
// abnormal terminations. The CLI's renderer desyncs if block indices or
// start/stop pairing are wrong, so those invariants are asserted directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamTranslator, type StreamEvent } from "../src/stream.ts";
import type { OpenAIStreamChunk } from "../src/types.ts";

function drain(chunks: OpenAIStreamChunk[], model = "m"): StreamEvent[] {
  const t = new StreamTranslator(model);
  const out: StreamEvent[] = [];
  for (const c of chunks) out.push(...t.feed(c));
  out.push(...t.flush());
  return out;
}

const text = (s: string): OpenAIStreamChunk => ({
  id: "x",
  choices: [{ index: 0, delta: { content: s }, finish_reason: null }],
});
const finish = (r: "stop" | "length" | "tool_calls"): OpenAIStreamChunk => ({
  id: "x",
  choices: [{ index: 0, delta: {}, finish_reason: r }],
});
const toolCall = (
  index: number,
  fn: { id?: string; name?: string; args?: string },
): OpenAIStreamChunk => ({
  id: "x",
  choices: [
    {
      index: 0,
      delta: {
        tool_calls: [
          {
            index,
            ...(fn.id ? { id: fn.id } : {}),
            function: { ...(fn.name ? { name: fn.name } : {}), ...(fn.args ? { arguments: fn.args } : {}) },
          },
        ],
      },
      finish_reason: null,
    },
  ],
});

/** Every content_block_start must have exactly one matching stop, same index. */
function assertBlocksBalanced(events: StreamEvent[]): void {
  const open: number[] = [];
  for (const e of events) {
    if (e.type === "content_block_start") {
      assert.ok(!open.includes(e.index as number), `index ${e.index} opened twice`);
      open.push(e.index as number);
    } else if (e.type === "content_block_stop") {
      const i = open.indexOf(e.index as number);
      assert.ok(i >= 0, `stop for index ${e.index} that was never started`);
      open.splice(i, 1);
    }
  }
  assert.deepEqual(open, [], "stream ended with unclosed content blocks");
}

/* ------------------------------ message frame ----------------------------- */

test("message_start and ping are emitted exactly once", () => {
  const events = drain([text("a"), text("b"), finish("stop")]);
  assert.equal(events.filter((e) => e.type === "message_start").length, 1);
  assert.equal(events.filter((e) => e.type === "ping").length, 1);
  assert.equal(events.filter((e) => e.type === "message_stop").length, 1);
});

test("message_start carries the model the request resolved to", () => {
  const start = drain([text("a"), finish("stop")], "glm-5.2:cloud")[0]!;
  assert.equal(start.type, "message_start");
  assert.equal((start.message as { model: string }).model, "glm-5.2:cloud");
});

/* ---------------------------- block transitions --------------------------- */

test("text then a tool call closes the text block before opening the tool block", () => {
  const events = drain([
    text("let me check"),
    toolCall(0, { id: "tc1", name: "run_bash", args: '{"command":"ls"}' }),
    finish("tool_calls"),
  ]);
  assertBlocksBalanced(events);
  const kinds = events
    .filter((e) => e.type === "content_block_start")
    .map((e) => (e.content_block as { type: string }).type);
  assert.deepEqual(kinds, ["text", "tool_use"]);
});

test("two tool calls occupy distinct, sequential block indices", () => {
  const events = drain([
    toolCall(0, { id: "a", name: "read", args: '{"p":1}' }),
    toolCall(1, { id: "b", name: "write", args: '{"p":2}' }),
    finish("tool_calls"),
  ]);
  assertBlocksBalanced(events);
  const idx = events.filter((e) => e.type === "content_block_start").map((e) => e.index);
  assert.deepEqual(idx, [0, 1]);
});

test("interleaved tool-call fragments land in the right block", () => {
  const t = new StreamTranslator("m");
  for (const c of [
    toolCall(0, { id: "a", name: "read", args: '{"p":' }),
    toolCall(1, { id: "b", name: "write", args: '{"q":' }),
    toolCall(0, { args: "1}" }),
    toolCall(1, { args: "2}" }),
    finish("tool_calls"),
  ]) {
    t.feed(c);
  }
  assert.deepEqual(t.parsedToolInputs(), { 0: { p: 1 }, 1: { q: 2 } });
});

test("a tool call arriving without an id still gets one", () => {
  // Anthropic requires a tool_use id; some backends omit it on the first chunk.
  const events = drain([toolCall(0, { name: "run", args: "{}" }), finish("tool_calls")]);
  const start = events.find((e) => e.type === "content_block_start")!;
  const block = start.content_block as { id: string; name: string };
  assert.ok(block.id.length > 0);
  assert.equal(block.name, "run");
});

/* ------------------------------ stop reasons ------------------------------ */

test("finish_reason maps onto Anthropic stop reasons", () => {
  const reasonOf = (r: "stop" | "length" | "tool_calls") => {
    const d = drain([text("x"), finish(r)]).find((e) => e.type === "message_delta")!;
    return (d.delta as { stop_reason: string }).stop_reason;
  };
  assert.equal(reasonOf("stop"), "end_turn");
  assert.equal(reasonOf("length"), "max_tokens");
  assert.equal(reasonOf("tool_calls"), "tool_use");
});

/* --------------------------- abnormal termination ------------------------- */

test("a stream cut off mid-block is still closed cleanly by flush", () => {
  // No finish_reason ever arrives (backend dropped the connection).
  const events = drain([text("partial")]);
  assertBlocksBalanced(events);
  assert.equal(events[events.length - 1]!.type, "message_stop");
  assert.equal(events.filter((e) => e.type === "message_delta").length, 1);
});

test("flush on a stream that never started emits nothing", () => {
  const t = new StreamTranslator("m");
  assert.deepEqual(t.flush(), []);
});

test("flush after a clean finish does not duplicate the terminators", () => {
  const events = drain([text("a"), finish("stop")]);
  assert.equal(events.filter((e) => e.type === "message_stop").length, 1);
  assert.equal(events.filter((e) => e.type === "message_delta").length, 1);
});

test("an empty-choices chunk is tolerated", () => {
  // Some backends emit a usage-only or keep-alive chunk with no choices.
  const events = drain([{ id: "x", choices: [] }, text("a"), finish("stop")]);
  assertBlocksBalanced(events);
  assert.equal(events[0]!.type, "message_start");
});

/* -------------------------------- reasoning ------------------------------- */

test("reasoning is suppressed once real content has arrived", () => {
  const chunks: OpenAIStreamChunk[] = [
    text("the answer"),
    { id: "x", choices: [{ index: 0, delta: { reasoning: "internal" }, finish_reason: null }] },
    finish("stop"),
  ];
  const body = drain(chunks)
    .filter((e) => e.type === "content_block_delta")
    .map((e) => (e.delta as { text?: string }).text ?? "")
    .join("");
  assert.equal(body, "the answer", "chain-of-thought must not leak into a real reply");
});

test("reasoning_content is accepted as well as reasoning", () => {
  const body = drain([
    { id: "x", choices: [{ index: 0, delta: { reasoning_content: "deepseek style" }, finish_reason: null }] },
    finish("stop"),
  ])
    .filter((e) => e.type === "content_block_delta")
    .map((e) => (e.delta as { text?: string }).text ?? "")
    .join("");
  assert.equal(body, "deepseek style");
});

test("a reasoning-only stream still produces a well-formed message", () => {
  // The blank-reply failure mode: budget consumed by reasoning, content empty.
  const events = drain([
    { id: "x", choices: [{ index: 0, delta: { reasoning: "thinking" }, finish_reason: null }] },
    finish("stop"),
  ]);
  assertBlocksBalanced(events);
  assert.ok(events.some((e) => e.type === "content_block_delta"));
});

test("parsedToolInputs surfaces malformed JSON rather than throwing", () => {
  const t = new StreamTranslator("m");
  t.feed(toolCall(0, { id: "a", name: "run", args: "{broken" }));
  t.feed(finish("tool_calls"));
  assert.deepEqual(t.parsedToolInputs()[0], { __raw: "{broken" });
});
