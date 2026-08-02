// Content that used to fall through the translation layer: images, extended
// thinking, image-bearing tool results, and the output-token clamp.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOpenAIRequest, imageToPart, translateMessage } from "../src/openaiShim.ts";
import { estimateInputTokens } from "../src/tokens.ts";
import type {
  AnthropicMessage,
  AnthropicMessagesRequest,
  OpenAIContentPart,
} from "../src/types.ts";

const PNG = { type: "base64" as const, media_type: "image/png", data: "iVBORw0KGgo=" };

test("inline images become data: URIs", () => {
  const part = imageToPart({ type: "image", source: PNG });
  assert.deepEqual(part, {
    type: "image_url",
    image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
  });
});

test("remote images keep their URL", () => {
  const part = imageToPart({
    type: "image",
    source: { type: "url", url: "https://example.com/a.png" },
  });
  assert.deepEqual(part, { type: "image_url", image_url: { url: "https://example.com/a.png" } });
});

test("a screenshot in a user turn reaches the backend", () => {
  const msg: AnthropicMessage = {
    role: "user",
    content: [
      { type: "text", text: "what's on screen?" },
      { type: "image", source: PNG },
    ],
  };
  const out = translateMessage(msg);
  assert.equal(out.length, 1);
  const parts = out[0]!.content as OpenAIContentPart[];
  assert.ok(Array.isArray(parts), "expected multimodal parts, not a flattened string");
  assert.equal(parts.length, 2);
  assert.equal(parts[0]!.type, "text");
  assert.equal(parts[1]!.type, "image_url");
});

test("text-only turns stay plain strings", () => {
  // Backends without vision support choke on the parts array, so only use it
  // when an image is actually present.
  const out = translateMessage({
    role: "user",
    content: [{ type: "text", text: "hi" }],
  });
  assert.deepEqual(out, [{ role: "user", content: "hi" }]);
});

test("an image returned by a tool survives as a following user message", () => {
  const out = translateMessage({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: [
          { type: "text", text: "captured" },
          { type: "image", source: PNG },
        ],
      },
    ],
  });
  assert.equal(out.length, 2);
  assert.equal(out[0]!.role, "tool");
  assert.equal(out[0]!.tool_call_id, "toolu_1");
  assert.equal(out[0]!.content, "captured");
  assert.equal(out[1]!.role, "user");
  const parts = out[1]!.content as OpenAIContentPart[];
  assert.equal(parts[0]!.type, "image_url");
});

test("a tool result with only an image still says something", () => {
  const out = translateMessage({
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "image", source: PNG }] },
    ],
  });
  // An empty tool message is rejected by some backends.
  assert.ok((out[0]!.content as string).length > 0);
});

test("thinking blocks are dropped without losing the reply", () => {
  const out = translateMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "internal reasoning", signature: "sig" },
      { type: "text", text: "the answer" },
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.content, "the answer");
});

test("max_tokens is clamped to the backend ceiling", () => {
  const req: AnthropicMessagesRequest = {
    model: "claude-sonnet-4-5",
    max_tokens: 32000,
    messages: [{ role: "user", content: "hi" }],
  };
  const capped = buildOpenAIRequest(req, "qwen2.5:7b", 4096);
  assert.equal(capped.max_tokens, 4096);
  assert.equal(capped.max_completion_tokens, 4096);

  // No cap configured → pass Claude Code's value straight through.
  const uncapped = buildOpenAIRequest(req, "qwen2.5:7b", null);
  assert.equal(uncapped.max_tokens, 32000);

  // A cap above the request must not inflate it.
  assert.equal(buildOpenAIRequest(req, "qwen2.5:7b", 100000).max_tokens, 32000);
});

test("token estimate counts system, messages and tool schemas", () => {
  const bare: AnthropicMessagesRequest = {
    model: "m",
    max_tokens: 10,
    messages: [{ role: "user", content: "hello world" }],
  };
  const withTools: AnthropicMessagesRequest = {
    ...bare,
    system: "you are a helpful assistant",
    tools: [
      {
        name: "run_bash",
        description: "run a shell command",
        input_schema: { type: "object", properties: { command: { type: "string" } } },
      },
    ],
  };
  const a = estimateInputTokens(bare);
  const b = estimateInputTokens(withTools);
  assert.ok(a > 0);
  assert.ok(b > a, "tool schemas and system prompt must be counted");
});

test("token estimate prices images well above their base64 length", () => {
  const withImage = estimateInputTokens({
    model: "m",
    max_tokens: 10,
    messages: [{ role: "user", content: [{ type: "image", source: PNG }] }],
  });
  // Undercounting here is what makes the CLI compact too late.
  assert.ok(withImage > 500, `expected a real image cost, got ${withImage}`);
});
