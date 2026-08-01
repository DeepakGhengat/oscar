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
  OpenAIChatCompletionRequest,
  OpenAIChatMessage,
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
function flattenText(blocks: AnthropicTextBlock[]): string {
  return blocks.map((b) => b.text).join("");
}

function toolResultToMessage(block: AnthropicToolResultBlock): OpenAIChatMessage {
  const content = typeof block.content === "string" ? block.content : flattenText(block.content);
  return {
    role: "tool",
    tool_call_id: block.tool_use_id,
    content,
  };
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
    // User turns may contain tool_result blocks (results of previous tool calls).
    const textParts: string[] = [];
    for (const block of msg.content) {
      if (block.type === "tool_result") {
        if (textParts.length) {
          out.push({ role: "user", content: textParts.join("") });
          textParts.length = 0;
        }
        out.push(toolResultToMessage(block));
      } else if (block.type === "text") {
        textParts.push(block.text);
      }
    }
    if (textParts.length) {
      out.push({ role: "user", content: textParts.join("") });
    }
    return out;
  }

  // Assistant turn: collect text + tool_calls together.
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
    // OpenAI's newer models use `max_completion_tokens`; keep both for compat.
    out.max_tokens = req.max_tokens;
    out.max_completion_tokens = req.max_tokens;
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