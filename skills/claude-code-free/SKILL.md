---
name: claude-code-free
description: Route Anthropic Claude Code requests to any OpenAI-compatible backend via a local translation proxy.
---

# Claude Code Free

A local proxy that translates Anthropic Messages API requests (`/v1/messages`)
into OpenAI Chat Completions requests (`/v1/chat/completions`) so the Claude Code
CLI can drive any OpenAI-compatible backend — OpenAI, DeepSeek, Ollama, LM
Studio, vLLM, etc.

## When to use

- You want to run the Claude Code CLI against a non-Anthropic model.
- You have an OpenAI-compatible endpoint and want Claude Code's agent loop on top of it.
- You want passthrough to real Anthropic as a fallback.

## Setup

1. Install the Claude Code SDK (ships the `claude` CLI binary):

   ```bash
   bash scripts/install-sdk.sh
   ```

2. Install Node deps:

   ```bash
   npm install
   ```

## Configuration (environment variables)

| Variable | Purpose | Required when |
|---|---|---|
| `USE_OPENAI_API=1` | Turn on OpenAI routing (translation mode) | OpenAI routing |
| `OPENAI_API_KEY` | API key sent as `Authorization: Bearer ...` to the backend | OpenAI routing |
| `OPENAI_MODEL` | Model name sent to the backend (e.g. `deepseek-chat`) | OpenAI routing |
| `OPENAI_BASE_URL` | Base URL of the OpenAI-compatible backend | OpenAI routing |
| `PROXY_PORT` | Port the proxy listens on (default `8787`) | optional |
| `ANTHROPIC_API_KEY` | Real Anthropic key for passthrough mode | passthrough |
| `ANTHROPIC_REAL_BASE_URL` | Anthropic endpoint for passthrough (default `https://api.anthropic.com`) | optional |

If `USE_OPENAI_API` is unset, the proxy forwards requests verbatim to the
Anthropic endpoint (passthrough mode) — no translation.

## Run

```bash
bash scripts/run.sh
```

This starts the proxy and launches the bundled `claude` CLI pointed at it
(`ANTHROPIC_BASE_URL=http://localhost:$PORT`).

## What it translates

- System prompts → first `system` message
- User/assistant messages → OpenAI `messages`
- Anthropic tools → OpenAI `tools` (function calling)
- `tool_choice` → OpenAI `tool_choice`
- Tool calls in the response → Anthropic `tool_use` content blocks
- SSE streaming → Anthropic SSE events (`message_start`, `content_block_delta`, `message_stop`, ...)

## Tests

```bash
bash scripts/run-tests.sh
```

Unit + integration tests run on Node (`node:test`) with in-process mock servers — no external network.