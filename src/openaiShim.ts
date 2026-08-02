// The "shim": bidirectional translation between Anthropic Messages API shapes
// and OpenAI Chat Completions shapes. Pure functions, no I/O — easy to unit test.

import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicTool,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  AnthropicTextBlock,
  AnthropicImageBlock,
  OpenAIChatCompletionRequest,
  OpenAIChatMessage,
  OpenAIContentPart,
  OpenAITool,
  OpenAIToolCall,
  OpenAIChatCompletionResponse,
  AnthropicMessagesResponse,
} from "./types.ts";

/* ------------------------- Anthropic → OpenAI ----------------------------- */

/** Anthropic tool defs use `input_schema`; OpenAI nests a `function.parameters`. */
export function translateTools(tools: AnthropicTool[] | undefined): OpenAITool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

export function translateToolChoice(
  choice: AnthropicMessagesRequest["tool_choice"],
): OpenAIChatCompletionRequest["tool_choice"] {
  if (!choice) return undefined;
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "tool":
      return { type: "function", function: { name: choice.name ?? "" } };
  }
}

/** Flatten Anthropic content blocks into a single OpenAI `content` string. */
function flattenText(blocks: Array<{ type: string; text?: string }>): string {
  return blocks.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
}

/** Anthropic image block → OpenAI `image_url` part. Inline bytes become a
 * data: URI, which is what OpenAI-compatible vision backends expect. */
export function imageToPart(block: AnthropicImageBlock): OpenAIContentPart {
  const src = block.source;
  if (src.type === "url") {
    return { type: "image_url", image_url: { url: src.url } };
  }
  return {
    type: "image_url",
    image_url: { url: `data:${src.media_type};base64,${src.data}` },
  };
}

/** Collapse accumulated parts into the narrowest shape a backend will accept:
 * a bare string when there's no image, the parts array otherwise. */
function narrowContent(parts: OpenAIContentPart[]): string | OpenAIContentPart[] {
  if (parts.every((p) => p.type === "text")) {
    return parts.map((p) => (p.type === "text" ? p.text : "")).join("");
  }
  return parts;
}

function toolResultToMessage(block: AnthropicToolResultBlock): OpenAIChatMessage[] {
  if (typeof block.content === "string") {
    return [{ role: "tool", tool_call_id: block.tool_use_id, content: block.content }];
  }

  // `role: "tool"` messages are text-only in the OpenAI schema, so an image
  // returned by a tool has to ride along in a following user message rather
  // than being dropped (Claude Code's screenshot tools do exactly this).
  const images = block.content.filter((b): b is AnthropicImageBlock => b.type === "image");
  const out: OpenAIChatMessage[] = [
    {
      role: "tool",
      tool_call_id: block.tool_use_id,
      content: flattenText(block.content) || (images.length ? "[see attached image]" : ""),
    },
  ];
  if (images.length) {
    out.push({ role: "user", content: images.map(imageToPart) });
  }
  return out;
}

/** Convert a single Anthropic message (with its content blocks) into one or more
 * OpenAI messages. A single assistant turn that contains both text and tool_use
 * becomes one assistant message (text + tool_calls); tool_result blocks become
 * separate `role: "tool"` messages. */
export function translateMessage(msg: AnthropicMessage): OpenAIChatMessage[] {
  // Plain string content is the common case for user turns.
  if (typeof msg.content === "string") {
    return [{ role: msg.role, content: msg.content }];
  }

  const out: OpenAIChatMessage[] = [];
  if (msg.role === "user") {
    // User turns may contain tool_result blocks (results of previous tool
    // calls) and images (screenshots, pasted pictures).
    let parts: OpenAIContentPart[] = [];
    const flushParts = () => {
      if (!parts.length) return;
      out.push({ role: "user", content: narrowContent(parts) });
      parts = [];
    };

    for (const block of msg.content) {
      if (block.type === "tool_result") {
        flushParts();
        out.push(...toolResultToMessage(block));
      } else if (block.type === "text") {
        parts.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        parts.push(imageToPart(block));
      }
    }
    flushParts();
    return out;
  }

  // Assistant turn: collect text + tool_calls together. Thinking blocks are
  // deliberately dropped — OpenAI has no field to replay them into, and
  // re-sending chain-of-thought as plain text corrupts the transcript.
  const textParts: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];
  for (const block of msg.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      });
    }
  }
  out.push({
    role: "assistant",
    content: textParts.length ? textParts.join("") : null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  });
  return out;
}

export function translateSystem(
  system: AnthropicMessagesRequest["system"],
): OpenAIChatMessage | null {
  if (!system) return null;
  if (typeof system === "string") return { role: "system", content: system };
  // Array of text blocks → join.
  return { role: "system", content: flattenText(system) };
}

/** Build the full OpenAI chat-completion request from an Anthropic request. */
export function buildOpenAIRequest(
  req: AnthropicMessagesRequest,
  modelOverride: string,
  /** Upper bound on output tokens. Claude Code sizes `max_tokens` for a
   * 200k-context Claude model; a smaller backend will either error or silently
   * truncate, so clamp when the real ceiling is known. */
  maxOutputTokens?: number | null,
): OpenAIChatCompletionRequest {
  const messages: OpenAIChatMessage[] = [];

  const sys = translateSystem(req.system);
  if (sys) messages.push(sys);

  for (const m of req.messages) {
    messages.push(...translateMessage(m));
  }

  const out: OpenAIChatCompletionRequest = {
    model: modelOverride,
    messages,
    stream: req.stream ?? false,
  };

  if (req.max_tokens) {
    const capped =
      maxOutputTokens && maxOutputTokens > 0
        ? Math.min(req.max_tokens, maxOutputTokens)
        : req.max_tokens;
    // OpenAI's newer models use `max_completion_tokens`; keep both for compat.
    out.max_tokens = capped;
    out.max_completion_tokens = capped;
  }
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop_sequences?.length) out.stop = req.stop_sequences;

  const tools = translateTools(req.tools);
  if (tools) out.tools = tools;
  const tc = translateToolChoice(req.tool_choice);
  if (tc) out.tool_choice = tc;

  return out;
}

/* ------------------------- OpenAI → Anthropic ---------------------------- */

function nanoid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Convert a finished (non-streaming) OpenAI completion into an Anthropic
 * Messages response. */
export function translateOpenAIResponse(
  res: OpenAIChatCompletionResponse,
  requestModel: string,
): AnthropicMessagesResponse {
  const choice = res.choices[0];
  if (!choice) {
    throw new Error("OpenAI response contained no choices");
  }

  const content: AnthropicContentBlock[] = [];
  if (choice.message.content) {
    content.push({ type: "text", text: choice.message.content });
  } else {
    // Reasoning models (glm-5.2:cloud, DeepSeek-R1, o1-style) place the
    // chain-of-thought in `message.reasoning` / `message.reasoning_content`
    // and may leave `content` empty when the token budget is consumed by
    // reasoning. Surface the reasoning as the reply so the caller never
    // sees a blank message. When real content is present, drop reasoning
    // (don't clutter the consumer's context with CoT).
    const reasoning = choice.message.reasoning ?? choice.message.reasoning_content;
    if (reasoning) {
      content.push({ type: "text", text: reasoning });
    }
  }
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: Record<string, unknown> = {};
      try {
        input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        input = { __raw: tc.function.arguments };
      }
      content.push({
        type: "tool_use",
        id: tc.id || nanoid("toolu"),
        name: tc.function.name,
        input,
      });
    }
  }

  const stop_reason: AnthropicMessagesResponse["stop_reason"] =
    choice.finish_reason === "tool_calls"
      ? "tool_use"
      : choice.finish_reason === "length"
        ? "max_tokens"
        : choice.finish_reason === "stop"
          ? "end_turn"
          : "end_turn";

  return {
    id: res.id || nanoid("msg"),
    type: "message",
    role: "assistant",
    model: requestModel,
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
    },
  };
}

/* ----------------------------- helpers ----------------------------------- */

/** Parse a streamed tool-call argument fragment safely (accummulated JSON string). */
export function safeParseToolInput(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { __raw: raw };
  }
}

export { nanoid };