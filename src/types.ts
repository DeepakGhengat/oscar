// Shared interfaces for the Anthropic ↔ OpenAI translation layer.
// Kept intentionally minimal: only the fields we actually read or write.

/* ----------------------------- Anthropic side ---------------------------- */

export type AnthropicRole = "user" | "assistant";

export interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: unknown;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Claude Code sends these for screenshots, pasted images and image-returning
 * tools. `base64` carries inline bytes; `url` points at a remote image. */
export interface AnthropicImageBlock {
  type: "image";
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
}

/** Extended-thinking blocks. They appear in assistant turns that get replayed
 * back to us; there is no OpenAI equivalent, so they're dropped on the way out. */
export interface AnthropicThinkingBlock {
  type: "thinking" | "redacted_thinking";
  thinking?: string;
  signature?: string;
  data?: string;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<AnthropicTextBlock | AnthropicImageBlock>;
  is_error?: boolean;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicThinkingBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: AnthropicRole;
  content: string | AnthropicContentBlock[];
}

export interface AnthropicToolInputSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: AnthropicToolInputSchema;
}

export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicTextBlock[];
  tools?: AnthropicTool[];
  tool_choice?: { type: "auto" | "any" | "tool"; name?: string };
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
}

export interface AnthropicMessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

/* ------------------------------- OpenAI side ----------------------------- */

export interface OpenAIFunctionDef {
  name: string;
  description?: string;
  parameters: AnthropicToolInputSchema;
}

export interface OpenAITool {
  type: "function";
  function: OpenAIFunctionDef;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Multimodal content parts. A message only needs the array form when it
 * actually carries an image; plain text stays a bare string for maximum
 * backend compatibility. */
export type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIChatMessage[];
  tools?: OpenAITool[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
}

export interface OpenAIChoiceMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  /** Reasoning-model chain-of-thought (e.g. glm-5.2, DeepSeek-R1, o1-style). */
  reasoning?: string;
  reasoning_content?: string;
}

export interface OpenAIChoice {
  index: number;
  message: OpenAIChoiceMessage;
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

export interface OpenAIChatCompletionResponse {
  id: string;
  model: string;
  choices: OpenAIChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/* ------------------------------- SSE stream ------------------------------ */

export interface OpenAIDelta {
  role?: "assistant";
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
  /** Reasoning-model chain-of-thought streamed fragments. */
  reasoning?: string;
  reasoning_content?: string;
}

export interface OpenAIStreamChunk {
  id: string;
  choices: Array<{
    index: number;
    delta: OpenAIDelta;
    finish_reason: OpenAIChoice["finish_reason"];
  }>;
}

/* ------------------------------- Proxy env ------------------------------- */

export interface ProxyConfig {
  useOpenAI: boolean;
  openAIKey: string | null;
  openAIModel: string | null;
  openAIBaseURL: string;
  /** Ceiling applied to max_tokens, or null to pass Claude Code's value through. */
  maxOutputTokens: number | null;
  anthropicKey: string | null;
  anthropicBaseURL: string;
  port: number;
}