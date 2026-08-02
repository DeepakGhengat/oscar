// Stream translator: consumes OpenAI SSE chat-completion chunks and emits
// Anthropic Messages streaming events (message_start, content_block_start,
// content_block_delta, content_block_stop, message_delta, message_stop).
//
// Anthropic streaming event reference:
//   message_start          → opens the message + initial usage
//   content_block_start    → opens a text or tool_use block (with index + id)
//   content_block_delta    → appends text_delta or input_json_delta
//   content_block_stop     → closes the block at index
//   message_delta          → updated stop_reason + final usage
//   message_stop           → ends the stream
//
// We buffer per-tool-call argument JSON so it can be streamed as
// `input_json_delta` partial strings, matching what the CLI renders.

import type { OpenAIStreamChunk } from "./types.ts";
import { safeParseToolInput, nanoid } from "./openaiShim.ts";

export interface StreamEvent {
  type:
    | "message_start"
    | "content_block_start"
    | "content_block_delta"
    | "content_block_stop"
    | "message_delta"
    | "message_stop"
    | "ping";
  [k: string]: unknown;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  argsBuffer: string;
  started: boolean;
}

export class StreamTranslator {
  private msgId: string;
  private model: string;
  private blockIndex = -1; // -1 = no block open
  private currentBlockKind: "text" | "tool_use" | null = null;
  private tools: ToolCallAccumulator[] = [];
  private stopReason: string = "end_turn";
  private stopReasonVal: string | null = null;
  private outputTokens = 0;
  private started = false;
  private sawContent = false; // true once any real content delta arrives

  constructor(model: string) {
    this.model = model;
    this.msgId = nanoid("msg");
  }

  /** Feed a parsed OpenAI chunk; returns 0..n Anthropic events to emit. */
  feed(chunk: OpenAIStreamChunk): StreamEvent[] {
    const events: StreamEvent[] = [];

    if (!this.started) {
      events.push({
        type: "message_start",
        message: {
          id: this.msgId,
          type: "message",
          role: "assistant",
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      events.push({ type: "ping" });
      this.started = true;
    }

    const choice = chunk.choices?.[0];
    if (!choice) return events;

    const delta = choice.delta ?? {};

    // ---- text content ----
    if (delta.content) {
      this.sawContent = true;
      if (this.currentBlockKind !== "text") {
        // close any open tool block first
        if (this.currentBlockKind === "tool_use") {
          events.push({ type: "content_block_stop", index: this.blockIndex });
        }
        this.blockIndex += 1;
        this.currentBlockKind = "text";
        events.push({
          type: "content_block_start",
          index: this.blockIndex,
          content_block: { type: "text", text: "" },
        });
      }
      events.push({
        type: "content_block_delta",
        index: this.blockIndex,
        delta: { type: "text_delta", text: delta.content },
      });
    }

    // ---- reasoning (chain-of-thought) ----
    // Reasoning models stream CoT via `delta.reasoning` /
    // `delta.reasoning_content`. Only surface it as a text block when no
    // real content has arrived (otherwise drop CoT to avoid clutter). This
    // prevents blank replies when the token budget is consumed by reasoning.
    const reasoningDelta = delta.reasoning ?? delta.reasoning_content;
    if (reasoningDelta && !this.sawContent) {
      if (this.currentBlockKind !== "text") {
        if (this.currentBlockKind === "tool_use") {
          events.push({ type: "content_block_stop", index: this.blockIndex });
        }
        this.blockIndex += 1;
        this.currentBlockKind = "text";
        events.push({
          type: "content_block_start",
          index: this.blockIndex,
          content_block: { type: "text", text: "" },
        });
      }
      events.push({
        type: "content_block_delta",
        index: this.blockIndex,
        delta: { type: "text_delta", text: reasoningDelta },
      });
    }

    // ---- tool calls ----
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        let slot = this.tools[idx];
        if (!slot) {
          slot = {
            id: tc.id || nanoid("toolu"),
            name: tc.function?.name ?? "",
            argsBuffer: "",
            started: false,
          };
          this.tools[idx] = slot;
        }
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name = tc.function.name;

        // open a tool_use block (close prior block first)
        if (!slot.started) {
          if (this.currentBlockKind === "text") {
            events.push({ type: "content_block_stop", index: this.blockIndex });
          } else if (this.currentBlockKind === "tool_use" && this.blockIndex >= 0) {
            events.push({ type: "content_block_stop", index: this.blockIndex });
          }
          this.blockIndex += 1;
          this.currentBlockKind = "tool_use";
          slot.started = true;
          events.push({
            type: "content_block_start",
            index: this.blockIndex,
            content_block: {
              type: "tool_use",
              id: slot.id,
              name: slot.name,
              input: {},
            },
          });
        }

        const frag = tc.function?.arguments ?? "";
        if (frag) {
          slot.argsBuffer += frag;
          events.push({
            type: "content_block_delta",
            index: this.blockIndex,
            delta: { type: "input_json_delta", partial_json: frag },
          });
        }
      }
    }

    // ---- finish ----
    if (choice.finish_reason) {
      this.stopReasonVal = choice.finish_reason;
      if (this.currentBlockKind !== null) {
        events.push({ type: "content_block_stop", index: this.blockIndex });
        this.currentBlockKind = null;
      }
      this.stopReason =
        choice.finish_reason === "tool_calls"
          ? "tool_use"
          : choice.finish_reason === "length"
            ? "max_tokens"
            : "end_turn";
      events.push({
        type: "message_delta",
        delta: {
          stop_reason: this.stopReason,
          stop_sequence: null,
        },
        usage: { output_tokens: this.outputTokens },
      });
      events.push({ type: "message_stop" });
    }

    return events;
  }

  /** Finalize in case the stream ended without an explicit finish_reason. */
  flush(): StreamEvent[] {
    const events: StreamEvent[] = [];
    if (!this.started) return events;
    if (this.currentBlockKind !== null) {
      events.push({ type: "content_block_stop", index: this.blockIndex });
      this.currentBlockKind = null;
    }
    if (this.stopReasonVal === null) {
      events.push({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: this.outputTokens },
      });
      events.push({ type: "message_stop" });
    }
    return events;
  }

  /** Parsed tool inputs, keyed by tool-call index — handy for tests/debug. */
  parsedToolInputs(): Record<number, Record<string, unknown>> {
    const out: Record<number, Record<string, unknown>> = {};
    for (const [i, t] of this.tools.entries()) {
      if (t) out[i] = safeParseToolInput(t.argsBuffer);
    }
    return out;
  }
}