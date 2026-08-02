// Streaming chat-completions client.
//
// O.S.C.A.R. talks to backends directly now, so there is no Anthropic format
// anywhere in this path — no translation, no proxy, no second process. Just
// OpenAI Chat Completions, which is what every supported backend speaks.

import type { Provider } from "../providers.ts";

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string as streamed; parse with `safeArgs`. */
  arguments: string;
}

export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface Turn {
  /** Assistant prose, assembled from the stream. */
  text: string;
  /** Tool calls the model asked for, if any. */
  toolCalls: ToolCall[];
  /** Why generation stopped. */
  finish: "stop" | "tool_calls" | "length" | "error";
  usage?: { input: number; output: number };
}

export interface StreamEvents {
  /** A chunk of visible prose. */
  onText?: (delta: string) => void;
  /** A chunk of chain-of-thought, for models that expose it separately. */
  onReasoning?: (delta: string) => void;
  /** Fired once per tool call as soon as its name is known. */
  onToolCallStart?: (name: string) => void;
}

/** Convert a wire message into what the backend expects. */
function wireMessage(m: Message): Record<string, unknown> {
  if (m.role === "assistant") {
    return {
      role: "assistant",
      content: m.content,
      ...(m.tool_calls?.length
        ? {
            tool_calls: m.tool_calls.map((t) => ({
              id: t.id,
              type: "function",
              function: { name: t.name, arguments: t.arguments },
            })),
          }
        : {}),
    };
  }
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
  }
  return { role: m.role, content: m.content };
}

/** Parse streamed tool arguments without throwing on a truncated payload. */
export function safeArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Run one turn against the backend, streaming as it goes. */
export async function complete(opts: {
  provider: Provider;
  model: string;
  messages: Message[];
  tools?: ToolSchema[];
  maxTokens?: number | null;
  signal?: AbortSignal;
  events?: StreamEvents;
}): Promise<Turn> {
  const { provider, model, messages, tools, maxTokens, signal, events } = opts;

  const body: Record<string, unknown> = {
    model,
    messages: messages.map(wireMessage),
    stream: true,
  };
  if (maxTokens && maxTokens > 0) {
    body.max_tokens = maxTokens;
    body.max_completion_tokens = maxTokens;
  }
  if (tools?.length) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = "auto";
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;

  const res = await fetch(`${provider.baseURL}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    const who = `${provider.baseURL} (provider "${provider.id}")`;
    if (res.status === 401 || res.status === 403) {
      throw new Error(`${who} rejected the API key (${res.status}). ${detail}`);
    }
    throw new Error(`${who} returned ${res.status}. ${detail}`);
  }
  if (!res.body) throw new Error("backend returned no response body");

  // ---- consume the SSE stream ----
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let finish: Turn["finish"] = "stop";
  let usage: Turn["usage"];
  const calls: ToolCall[] = [];
  const announced = new Set<number>();
  let sawText = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line || line.startsWith(":")) continue;
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        buffer = "";
        break;
      }

      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(payload) as StreamChunk;
      } catch {
        continue; // keep-alive or partial frame
      }

      if (chunk.usage) {
        usage = {
          input: chunk.usage.prompt_tokens ?? 0,
          output: chunk.usage.completion_tokens ?? 0,
        };
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};

      if (delta.content) {
        sawText = true;
        text += delta.content;
        events?.onText?.(delta.content);
      }

      // Reasoning models can spend their whole budget thinking and return no
      // content at all. Surface it rather than showing the user nothing.
      const reasoning = delta.reasoning ?? delta.reasoning_content;
      if (reasoning && !sawText) events?.onReasoning?.(reasoning);

      for (const tc of delta.tool_calls ?? []) {
        const slot = (calls[tc.index] ??= { id: "", name: "", arguments: "" });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name = tc.function.name;
        if (tc.function?.arguments) slot.arguments += tc.function.arguments;
        if (slot.name && !announced.has(tc.index)) {
          announced.add(tc.index);
          events?.onToolCallStart?.(slot.name);
        }
      }

      if (choice.finish_reason) {
        finish =
          choice.finish_reason === "tool_calls"
            ? "tool_calls"
            : choice.finish_reason === "length"
              ? "length"
              : "stop";
      }
    }
  }

  const toolCalls = calls.filter(Boolean).map((t, i) => ({
    ...t,
    id: t.id || `call_${i}`,
  }));
  // Some backends report "stop" even while emitting tool calls.
  if (toolCalls.length && finish === "stop") finish = "tool_calls";

  return { text, toolCalls, finish, usage };
}
