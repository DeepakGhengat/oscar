// Local token estimation for POST /v1/messages/count_tokens.
//
// The CLI calls that endpoint to decide when to compact a conversation.
// Forwarding it to api.anthropic.com is not an option in OpenAI-routing mode —
// the CLI is holding a dummy key, so the call 401s and the CLI loses its
// context accounting. OpenAI-compatible backends don't offer an equivalent
// endpoint, so we estimate locally.
//
// The estimate only has to be good enough to trigger compaction at a sane
// point, and it should err high: undercounting means the CLI compacts too late
// and the backend rejects an over-long prompt.

import type { MessagesRequest, ContentBlock } from "./types.ts";

/** Characters per token. Real BPE averages ~4 for prose and ~3 for code and
 * JSON; 3.2 keeps the estimate on the safe (high) side for both. */
const CHARS_PER_TOKEN = 3.2;

/** Rough per-message framing cost (role markers, delimiters). */
const PER_MESSAGE_OVERHEAD = 4;

/** A base64 image costs far less than its encoded length suggests — Anthropic
 * bills roughly (w*h)/750, and ~1100 is a reasonable stand-in for the
 * screenshot-sized images the CLI sends. */
const PER_IMAGE_TOKENS = 1100;

function textTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

function blockTokens(block: ContentBlock): number {
  switch (block.type) {
    case "text":
      return textTokens(block.text);
    case "image":
      return PER_IMAGE_TOKENS;
    case "thinking":
    case "redacted_thinking":
      return textTokens(block.thinking ?? block.data ?? "");
    case "tool_use":
      return textTokens(block.name) + textTokens(JSON.stringify(block.input ?? {}));
    case "tool_result": {
      if (typeof block.content === "string") return textTokens(block.content);
      return block.content.reduce(
        (sum, b) => sum + (b.type === "image" ? PER_IMAGE_TOKENS : textTokens(b.text ?? "")),
        0,
      );
    }
    default:
      return 0;
  }
}

/** Estimate the input tokens an Anthropic-shaped request would consume. */
export function estimateInputTokens(req: MessagesRequest): number {
  let total = 0;

  if (typeof req.system === "string") {
    total += textTokens(req.system);
  } else if (Array.isArray(req.system)) {
    // Join before counting: rounding each block up separately inflates the
    // estimate and makes a split prompt cost more than the same text unsplit.
    total += textTokens(req.system.map((b) => b.text).join(""));
  }

  for (const msg of req.messages) {
    total += PER_MESSAGE_OVERHEAD;
    if (typeof msg.content === "string") {
      total += textTokens(msg.content);
    } else {
      for (const block of msg.content) total += blockTokens(block);
    }
  }

  // Tool definitions are re-sent on every request and are pure JSON schema —
  // on a full the CLI tool set this is thousands of tokens, so counting it
  // matters more than the message framing does.
  for (const tool of req.tools ?? []) {
    total += textTokens(tool.name);
    total += textTokens(tool.description ?? "");
    total += textTokens(JSON.stringify(tool.input_schema ?? {}));
  }

  return total;
}
