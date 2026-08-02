// Translation unit tests — no network. Run with: npx tsx --test test/cases.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildOpenAIRequest,
  translateTools,
  translateToolChoice,
  translateMessage,
  translateSystem,
  translateOpenAIResponse,
  safeParseToolInput,
} from "../src/openaiShim.ts";
import { StreamTranslator } from "../src/stream.ts";
import type {
  ChatMessage,
  MessagesRequest,
  ToolDef,
  OpenAIChatCompletionResponse,
  OpenAIStreamChunk,
} from "../src/types.ts";

/* --------------------------- Tool translation ----------------------------- */

test("translateTools maps input_schema → function.parameters", () => {
  const tools: ToolDef[] = [
    {
      name: "run_bash",
      description: "Run a shell command",
      input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  ];
  const out = translateTools(tools);
  assert.deepEqual(out, [
    {
      type: "function",
      function: {
        name: "run_bash",
        description: "Run a shell command",
        parameters: tools[0]!.input_schema,
      },
    },
  ]);
});

test("translateTools returns undefined for empty/missing", () => {
  assert.strictEqual(translateTools(undefined), undefined);
  assert.strictEqual(translateTools([]), undefined);
});

test("translateToolChoice maps any→required, tool→named function", () => {
  assert.strictEqual(translateToolChoice({ type: "auto" }), "auto");
  assert.strictEqual(translateToolChoice({ type: "any" }), "required");
  assert.deepEqual(translateToolChoice({ type: "tool", name: "run_bash" }), {
    type: "function",
    function: { name: "run_bash" },
  });
  assert.strictEqual(translateToolChoice(undefined), undefined);
});

/* --------------------------- Message translation -------------------------- */

test("translateMessage: plain user string", () => {
  const m: ChatMessage = { role: "user", content: "hello" };
  assert.deepEqual(translateMessage(m), [{ role: "user", content: "hello" }]);
});

test("translateMessage: text blocks flatten to one string", () => {
  const m: ChatMessage = {
    role: "user",
    content: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
  };
  assert.deepEqual(translateMessage(m), [{ role: "user", content: "ab" }]);
});

test("translateMessage: assistant text + tool_use → content + tool_calls", () => {
  const m: ChatMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "thinking..." },
      { type: "tool_use", id: "t1", name: "run_bash", input: { command: "ls" } },
    ],
  };
  const out = translateMessage(m);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    role: "assistant",
    content: "thinking...",
    tool_calls: [
      { id: "t1", type: "function", function: { name: "run_bash", arguments: JSON.stringify({ command: "ls" }) } },
    ],
  });
});

test("translateMessage: tool_result in user turn → role:tool messages", () => {
  const m: ChatMessage = {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "t1", content: "file.txt" },
      { type: "text", text: "next step" },
    ],
  };
  const out = translateMessage(m);
  assert.deepEqual(out, [
    { role: "tool", tool_call_id: "t1", content: "file.txt" },
    { role: "user", content: "next step" },
  ]);
});

test("translateSystem: string and block-array", () => {
  assert.deepEqual(translateSystem("be brief"), { role: "system", content: "be brief" });
  assert.deepEqual(translateSystem([{ type: "text", text: "a" }, { type: "text", text: "b" }]), {
    role: "system",
    content: "ab",
  });
  assert.strictEqual(translateSystem(undefined), null);
});

/* --------------------------- Full request build -------------------------- */

test("buildOpenAIRequest assembles system + messages + tools + model override", () => {
  const req: MessagesRequest = {
    model: "claude-3-5-sonnet",
    max_tokens: 1024,
    system: "you are helpful",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      { name: "f", input_schema: { type: "object", properties: { x: { type: "number" } } } },
    ],
    tool_choice: { type: "auto" },
  };
  const out = buildOpenAIRequest(req, "deepseek-chat");
  assert.strictEqual(out.model, "deepseek-chat");
  assert.strictEqual(out.max_tokens, 1024);
  assert.strictEqual(out.max_completion_tokens, 1024);
  assert.deepEqual(out.messages[0], { role: "system", content: "you are helpful" });
  assert.deepEqual(out.messages[1], { role: "user", content: "hi" });
  assert.strictEqual(out.tools?.[0]?.function.name, "f");
  assert.strictEqual(out.tool_choice, "auto");
});

test("buildOpenAIRequest respects stream flag and stop_sequences", () => {
  const req: MessagesRequest = {
    model: "x",
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    stop_sequences: ["END"],
  };
  const out = buildOpenAIRequest(req, "m");
  assert.strictEqual(out.stream, true);
  assert.deepEqual(out.stop, ["END"]);
});

/* ------------------------ OpenAI → Anthropic response --------------------- */

test("translateOpenAIResponse: text only → end_turn", () => {
  const res: OpenAIChatCompletionResponse = {
    id: "c1",
    model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content: "hi there" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  };
  const out = translateOpenAIResponse(res, "claude-3-5-sonnet");
  assert.strictEqual(out.role, "assistant");
  assert.deepEqual(out.content, [{ type: "text", text: "hi there" }]);
  assert.strictEqual(out.stop_reason, "end_turn");
  assert.deepEqual(out.usage, { input_tokens: 5, output_tokens: 2 });
});

test("translateOpenAIResponse: tool_calls → tool_use + stop_reason tool_use", () => {
  const res: OpenAIChatCompletionResponse = {
    id: "c1",
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "tc1", type: "function", function: { name: "run_bash", arguments: JSON.stringify({ command: "ls" }) } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
  };
  const out = translateOpenAIResponse(res, "claude");
  assert.strictEqual(out.stop_reason, "tool_use");
  assert.deepEqual(out.content[0], {
    type: "tool_use",
    id: "tc1",
    name: "run_bash",
    input: { command: "ls" },
  });
});

test("translateOpenAIResponse: empty content + reasoning → text block from reasoning", () => {
  const res: OpenAIChatCompletionResponse = {
    id: "c1",
    model: "glm-5.2",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: null, reasoning: "1. Analyze the greeting.\n2. Respond." },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 },
  };
  const out = translateOpenAIResponse(res, "claude-3-5-sonnet");
  assert.deepEqual(out.content, [{ type: "text", text: "1. Analyze the greeting.\n2. Respond." }]);
  assert.strictEqual(out.stop_reason, "end_turn");
});

test("translateOpenAIResponse: content present drops reasoning (no CoT clutter)", () => {
  const res: OpenAIChatCompletionResponse = {
    id: "c1",
    model: "glm-5.2",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello there!", reasoning: "1. think..." },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  };
  const out = translateOpenAIResponse(res, "claude-3-5-sonnet");
  assert.deepEqual(out.content, [{ type: "text", text: "Hello there!" }]);
});

test("safeParseToolInput handles bad JSON gracefully", () => {
  assert.deepEqual(safeParseToolInput(""), {});
  assert.deepEqual(safeParseToolInput('{"a":1}'), { a: 1 });
  assert.deepEqual(safeParseToolInput("{bad"), { __raw: "{bad" });
});

/* ----------------------------- Streaming --------------------------------- */

function eventsOf(chunks: OpenAIStreamChunk[], model = "m"): string[] {
  const t = new StreamTranslator(model);
  const out: string[] = [];
  for (const c of chunks) for (const e of t.feed(c)) out.push(e.type);
  for (const e of t.flush()) out.push(e.type);
  return out;
}

test("stream: text-only emits start/delta/stop sequence", () => {
  const chunks: OpenAIStreamChunk[] = [
    { id: "a", choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }] },
    { id: "a", choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }] },
    { id: "a", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  assert.deepEqual(eventsOf(chunks), [
    "message_start",
    "ping",
    "content_block_start",
    "content_block_delta",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
});

test("stream: reasoning-only deltas surface as text block when content absent", () => {
  const chunks: OpenAIStreamChunk[] = [
    { id: "a", choices: [{ index: 0, delta: { reasoning: "1. think" }, finish_reason: null }] },
    { id: "a", choices: [{ index: 0, delta: { reasoning: " 2. answer" }, finish_reason: null }] },
    { id: "a", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  const t = new StreamTranslator("m");
  const text: string[] = [];
  for (const c of chunks) {
    for (const e of t.feed(c)) {
      if (e.type === "content_block_delta") {
        const d = e.delta as { type?: string; text?: string };
        if (d.type === "text_delta" && typeof d.text === "string") text.push(d.text);
      }
    }
  }
  for (const e of t.flush()) void e;
  assert.strictEqual(text.join(""), "1. think 2. answer");
});

test("stream: tool_calls accumulate input_json_delta and finish with tool_use", () => {
  const chunks: OpenAIStreamChunk[] = [
    { id: "a", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "tc1", function: { name: "run_bash", arguments: '{"command":' } }] }, finish_reason: null }] },
    { id: "a", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ' "ls"}' } }] }, finish_reason: null }] },
    { id: "a", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
  const t = new StreamTranslator("m");
  const deltas: string[] = [];
  for (const c of chunks) {
    for (const e of t.feed(c)) {
      if (e.type === "content_block_delta") {
        const delta = e.delta as { partial_json?: string };
        if (typeof delta.partial_json === "string") deltas.push(delta.partial_json);
      }
    }
  }
  for (const e of t.flush()) void e;
  assert.strictEqual(deltas.join(""), '{"command": "ls"}');
  assert.deepEqual(t.parsedToolInputs()[0], { command: "ls" });
});