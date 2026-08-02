// Remaining openaiShim + tokens surface: optional sampling params, response
// edge cases, and estimator behaviour on every block type.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildOpenAIRequest,
  nanoid,
  translateMessage,
  translateOpenAIResponse,
  translateSystem,
} from "../src/openaiShim.ts";
import { estimateInputTokens } from "../src/tokens.ts";
import type {
  MessagesRequest,
  OpenAIChatCompletionResponse,
} from "../src/types.ts";

const base: MessagesRequest = {
  model: "claude-sonnet-4-5",
  max_tokens: 100,
  messages: [{ role: "user", content: "hi" }],
};

/* ---------------------------- request assembly ---------------------------- */

test("temperature and top_p are forwarded only when set", () => {
  const bare = buildOpenAIRequest(base, "m");
  assert.equal(bare.temperature, undefined);
  assert.equal(bare.top_p, undefined);

  const full = buildOpenAIRequest({ ...base, temperature: 0.2, top_p: 0.9 }, "m");
  assert.equal(full.temperature, 0.2);
  assert.equal(full.top_p, 0.9);
});

test("temperature 0 survives (it is not treated as absent)", () => {
  // A `if (req.temperature)` check would drop this and silently change output.
  assert.equal(buildOpenAIRequest({ ...base, temperature: 0 }, "m").temperature, 0);
});

test("empty stop_sequences are omitted rather than sent as []", () => {
  assert.equal(buildOpenAIRequest({ ...base, stop_sequences: [] }, "m").stop, undefined);
});

test("stream defaults to false when the request omits it", () => {
  assert.equal(buildOpenAIRequest(base, "m").stream, false);
});

test("both max_tokens spellings are emitted for backend compatibility", () => {
  const out = buildOpenAIRequest(base, "m");
  assert.equal(out.max_tokens, 100);
  assert.equal(out.max_completion_tokens, 100);
});

test("an empty system prompt is not sent as a blank system message", () => {
  assert.equal(translateSystem(""), null);
  assert.equal(buildOpenAIRequest({ ...base, system: "" }, "m").messages[0]!.role, "user");
});

test("message order is preserved through translation", () => {
  const out = buildOpenAIRequest(
    {
      ...base,
      system: "sys",
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
      ],
    },
    "m",
  );
  assert.deepEqual(
    out.messages.map((m) => [m.role, m.content]),
    [
      ["system", "sys"],
      ["user", "one"],
      ["assistant", "two"],
      ["user", "three"],
    ],
  );
});

/* ---------------------------- response handling --------------------------- */

function response(over: Partial<OpenAIChatCompletionResponse["choices"][0]> = {}, usage = true) {
  return {
    id: "c1",
    model: "m",
    choices: [
      { index: 0, message: { role: "assistant" as const, content: "hi" }, finish_reason: "stop" as const, ...over },
    ],
    ...(usage ? { usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } } : {}),
  } as OpenAIChatCompletionResponse;
}

test("a response with no choices fails loudly", () => {
  const empty = { id: "c", model: "m", choices: [] } as OpenAIChatCompletionResponse;
  assert.throws(() => translateOpenAIResponse(empty, "claude"), /no choices/);
});

test("missing usage reports zeros instead of undefined", () => {
  const out = translateOpenAIResponse(response({}, false), "claude");
  assert.deepEqual(out.usage, { input_tokens: 0, output_tokens: 0 });
});

test("finish_reason length maps to max_tokens", () => {
  assert.equal(translateOpenAIResponse(response({ finish_reason: "length" }), "c").stop_reason, "max_tokens");
});

test("content_filter and null finish_reason degrade to end_turn", () => {
  assert.equal(translateOpenAIResponse(response({ finish_reason: "content_filter" }), "c").stop_reason, "end_turn");
  assert.equal(translateOpenAIResponse(response({ finish_reason: null }), "c").stop_reason, "end_turn");
});

test("the response echoes the model the caller asked for", () => {
  // The CLI matches this against what it requested.
  assert.equal(translateOpenAIResponse(response(), "claude-oscar-glm-5.2-cloud").model, "claude-oscar-glm-5.2-cloud");
});

test("a missing response id is replaced with a generated one", () => {
  const res = { ...response(), id: "" } as OpenAIChatCompletionResponse;
  assert.match(translateOpenAIResponse(res, "c").id, /^msg_/);
});

test("unparseable tool arguments are preserved as __raw, not dropped", () => {
  const out = translateOpenAIResponse(
    response({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "t1", type: "function", function: { name: "run", arguments: "{broken" } }],
      },
      finish_reason: "tool_calls",
    }),
    "c",
  );
  const block = out.content[0]!;
  assert.equal(block.type, "tool_use");
  if (block.type === "tool_use") assert.deepEqual(block.input, { __raw: "{broken" });
});

test("empty tool arguments become an empty object", () => {
  const out = translateOpenAIResponse(
    response({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "t1", type: "function", function: { name: "run", arguments: "" } }],
      },
      finish_reason: "tool_calls",
    }),
    "c",
  );
  const block = out.content[0]!;
  if (block.type === "tool_use") assert.deepEqual(block.input, {});
});

test("text and tool_use can coexist in one response", () => {
  const out = translateOpenAIResponse(
    response({
      message: {
        role: "assistant",
        content: "running it now",
        tool_calls: [{ id: "t1", type: "function", function: { name: "run", arguments: "{}" } }],
      },
      finish_reason: "tool_calls",
    }),
    "c",
  );
  assert.deepEqual(out.content.map((b) => b.type), ["text", "tool_use"]);
});

test("reasoning_content is used when reasoning is absent", () => {
  const out = translateOpenAIResponse(
    response({ message: { role: "assistant", content: null, reasoning_content: "deepseek CoT" } }),
    "c",
  );
  assert.deepEqual(out.content, [{ type: "text", text: "deepseek CoT" }]);
});

test("a wholly empty message yields empty content, not a crash", () => {
  const out = translateOpenAIResponse(response({ message: { role: "assistant", content: null } }), "c");
  assert.deepEqual(out.content, []);
});

test("nanoid produces distinct prefixed ids", () => {
  const ids = new Set(Array.from({ length: 200 }, () => nanoid("toolu")));
  assert.equal(ids.size, 200, "collisions would cross-link tool calls");
  for (const id of ids) assert.match(id, /^toolu_/);
});

/* ------------------------------ empty content ----------------------------- */

test("a user turn with no renderable blocks produces no message", () => {
  assert.deepEqual(translateMessage({ role: "user", content: [] }), []);
});

test("an assistant turn with only thinking still yields a message slot", () => {
  const out = translateMessage({
    role: "assistant",
    content: [{ type: "thinking", thinking: "..." }],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.content, null);
});

/* -------------------------------- estimator ------------------------------- */

test("estimator handles an empty request", () => {
  assert.equal(estimateInputTokens({ model: "m", max_tokens: 1, messages: [] }), 0);
});

test("estimator counts a block-array system prompt", () => {
  const flat = estimateInputTokens({ ...base, system: "you are helpful" });
  const blocks = estimateInputTokens({
    ...base,
    system: [{ type: "text", text: "you are " }, { type: "text", text: "helpful" }],
  });
  assert.equal(flat, blocks);
});

test("estimator counts tool_use inputs and tool_result payloads", () => {
  const withTool = estimateInputTokens({
    ...base,
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "read", input: { path: "/very/long/path/to/a/file.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x".repeat(400) }] },
    ],
  });
  assert.ok(withTool > 100, `expected the 400-char tool result to be counted, got ${withTool}`);
});

test("estimator counts redacted_thinking without throwing", () => {
  const n = estimateInputTokens({
    ...base,
    messages: [{ role: "assistant", content: [{ type: "redacted_thinking", data: "y".repeat(100) }] }],
  });
  assert.ok(n > 0);
});

test("estimator grows monotonically with content", () => {
  const short = estimateInputTokens({ ...base, messages: [{ role: "user", content: "hi" }] });
  const long = estimateInputTokens({ ...base, messages: [{ role: "user", content: "hi".repeat(1000) }] });
  assert.ok(long > short * 10);
});

test("estimator errs high rather than low", () => {
  // Undercounting makes the CLI compact too late and blow the context.
  const chars = 4000;
  const n = estimateInputTokens({ ...base, messages: [{ role: "user", content: "a".repeat(chars) }] });
  assert.ok(n >= chars / 4, `${n} tokens for ${chars} chars is an undercount`);
});
