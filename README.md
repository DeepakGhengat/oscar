<div align="center">

# claude-code-free

*Run Claude Code against any model you want — local Ollama, DeepSeek, OpenAI, LM Studio, vLLM — without patching a single line of Claude Code.*

[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-228%20passing-brightgreen)]()
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE.md)

</div>

---

## What it is

Claude Code is an excellent coding agent — the tools, the agent loop, the terminal UI, the permission model. It is also hard-wired to Anthropic's API.

claude-code-free is a **local translation proxy** that sits in between. Claude Code thinks it is talking to `api.anthropic.com`; claude-code-free converts every request into OpenAI Chat Completions format and forwards it to whatever backend you actually want.

You keep the entire Claude Code experience. You change only which model answers.

```
  Claude Code                claude-code-free (localhost:8787)    your backend
  ───────────                ─────────────────────────────────    ────────────
  ANTHROPIC_BASE_URL ──────► GET  /v1/models      ───────────────► GET  /models
  ANTHROPIC_API_KEY=dummy    POST /v1/messages    ──translate────► POST /chat/completions
                             POST /v1/messages/count_tokens
                                  (answered locally)
                             anything else        ───────────────► api.anthropic.com
```

## Why it exists

Most "use Claude Code with another model" setups give you a working proxy and a broken `/model` command — you edit a config file and restart to change models.

claude-code-free makes `/model` work. Every model on every configured backend shows up in Claude Code's own picker, switchable mid-session:

```
  qwen2.5:7b           (local)
  llama3               (local)
  glm-5.2              (cloud)
  deepseek-v4-pro      (cloud)
  gpt-oss:120b         (cloud)
```

## Features

| | |
|---|---|
| **Native `/model` picker** | Every backend model appears in Claude Code's own model list |
| **Multiple backends at once** | Local Ollama *and* DeepSeek *and* OpenAI in one picker, each with its own key |
| **Full tool-call translation** | `tool_use` / `tool_result` round-trip correctly, so the agent loop works |
| **Streaming** | OpenAI SSE → Anthropic event stream, token by token |
| **Vision** | Screenshots and pasted images translate to `image_url` parts |
| **Reasoning models** | Surfaces chain-of-thought when `content` comes back empty, so no blank replies |
| **Local token counting** | Claude Code keeps accurate context accounting |
| **Per-model token ceilings** | Cap a small local model without touching the others |
| **Health checks** | `claude-code-free --doctor` proves the setup works with a real completion |
| **Passthrough mode** | Flip one flag and every request goes to the real Anthropic API, untouched |

---

## Requirements

- **Node.js ≥ 18** — `node --version`
- **Claude Code** — the desktop app's bundled copy is found automatically, or `npm i -g @anthropic-ai/claude-code`
- **A backend** — [Ollama](https://ollama.com) is the easiest; anything OpenAI-compatible works

## Installation

```bash
git clone https://github.com/LORDCYBERGOD/oscar.git
cd oscar
```

Install as a product (a real copy, not a dev link):

```bash
npm pack
```

```bash
npm install -g ./claude-code-free-0.1.0.tgz
```

```bash
rm claude-code-free-0.1.0.tgz
```

> **Why `npm pack` first?** `npm install -g .` on a local path creates a *symlink* to your working tree, not an installation. Packing first gives you a genuine copy containing only `src/`, `bin/` and `scripts/` — 25 files, ~43 kB.

For development instead, link the working tree so edits take effect immediately:

```bash
npm install && npm link
```

### Windows note

Everything above is identical in PowerShell except path separators (`.\claude-code-free-0.1.0.tgz`). If PowerShell refuses to run the generated shim, its execution policy is too strict:

```bash
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

## Setup

```bash
claude-code-free --setup
```

The wizard asks for a provider, collects a key and model, then **sends one real one-token completion to prove it works** before writing `~/.claude-code-free/.env`.

That last check matters more than it sounds — see [Why listing models proves nothing](#why-listing-models-proves-nothing).

Verify:

```bash
claude-code-free --doctor
```

Run it:

```bash
claude-code-free
```

Any extra arguments pass straight through to Claude Code:

```bash
claude-code-free -p "explain the architecture of this repo"
```

---

## Commands

| Command | What it does |
|---|---|
| `claude-code-free` | Start the proxy and launch Claude Code against it |
| `claude-code-free --setup` | Interactive wizard; writes `~/.claude-code-free/.env` |
| `claude-code-free --doctor` | Check every backend, ending with a live completion. Exits non-zero on failure |
| `claude-code-free --model` | Pick a model and write it to `.env` |
| `claude-code-free --switch` | Hot-swap the model on a **running** proxy, from a second terminal |

## Configuration

### Single backend — `~/.claude-code-free/.env`

| Variable | Purpose | Default |
|---|---|---|
| `USE_OPENAI_API` | `1` routes to your backend; anything else passes through to Anthropic | unset |
| `OPENAI_BASE_URL` | Backend base URL | `https://api.openai.com/v1` |
| `OPENAI_API_KEY` | Backend key | required when routing |
| `OPENAI_MODEL` | Default model | required when routing |
| `CCF_MAX_OUTPUT_TOKENS` | Clamp on `max_tokens` — Claude Code asks for a 200k-context budget | unset (no clamp) |
| `PROXY_PORT` | Port the proxy listens on | `8787` |
| `ANTHROPIC_API_KEY` | Used only in passthrough mode | — |

Example:

```bash
USE_OPENAI_API=1
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=ollama
OPENAI_MODEL=qwen2.5:7b
PROXY_PORT=8787
```

### Multiple backends — `~/.claude-code-free/providers.json`

```json
{
  "providers": {
    "local": {
      "baseURL": "http://localhost:11434/v1",
      "apiKey": "ollama",
      "models": { "qwen2.5:7b": { "maxOutputTokens": 4096 } }
    },
    "cloud": {
      "baseURL": "https://ollama.com/v1",
      "apiKey": "sk-..."
    },
    "deepseek": {
      "baseURL": "https://api.deepseek.com/v1",
      "apiKey": "sk-...",
      "maxOutputTokens": 8192
    }
  }
}
```

Every backend is probed together and appears in one picker as `model  (provider)`. Each request uses that provider's own base URL and key. Two backends serving the same model name stay individually addressable.

Output-token ceilings resolve **model → provider → `CCF_MAX_OUTPUT_TOKENS`**.

Without a `providers.json`, the flat `.env` is used as a single provider — nothing changes for existing setups.

---

## How it works

### 1. Launch

`claude-code-free` performs nine steps:

1. Load `~/.claude-code-free/.env`
2. Spawn the proxy (`src/server.ts`) as a child process
3. Poll `/healthz` until it answers
4. Set `ANTHROPIC_BASE_URL` to the proxy
5. Set `ANTHROPIC_API_KEY` to a dummy value — the proxy ignores it and uses your backend key
6. Set `CLAUDE_CONFIG_DIR` to a throwaway profile, so a stale OAuth token can't override the dummy key
7. Set `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`
8. Launch Claude Code
9. Tear the proxy down on exit

Meanwhile the proxy **warms its model catalog**, because the next step has a hard deadline.

### 2. Model discovery — the interesting part

Claude Code fetches `{ANTHROPIC_BASE_URL}/v1/models?limit=1000` **exactly once** at startup, gives up after 3 seconds, and folds the result into its `/model` picker.

Then it applies this filter to the ids it got back:

```js
data.filter((m) => /^(claude|anthropic)/i.test(m.id))
```

Anything else is silently discarded — which would drop every Ollama model on the floor. So claude-code-free advertises each model under an alias that survives the filter, and puts the real name in `display_name`, which is what the picker actually renders:

| Sent as `id` | Shown in `/model` |
|---|---|
| `claude-ccf-local-qwen2.5-7b` | `qwen2.5:7b  (local)` |
| `claude-ccf-cloud-glm-5.2` | `glm-5.2  (cloud)` |

Because that fetch happens *once*, a backend that is merely slow on its first request would be missing from `/model` for the entire session. That is why the catalog is warmed at boot with a 15-second budget while the request path keeps a 2.5-second one, and why a partial result is cached for 5 seconds instead of 60.

### 3. Each message

You pick a model; Claude Code sends its alias as `body.model`. The proxy:

1. Maps the alias back to a **provider + real model name**
2. Translates Anthropic → OpenAI: system prompt, message history, tool definitions (`input_schema` → `function.parameters`), `tool_use` / `tool_result` blocks, images as data URIs
3. Clamps `max_tokens` (model → provider → global)
4. POSTs to **that provider's** URL with **that provider's** key
5. Translates the response back, including SSE → Anthropic's `message_start` → `content_block_delta` → `message_stop` sequence

Token counting is answered locally, because forwarding it with the dummy key would 401 and cost Claude Code its context accounting.

### Architecture

```
src/
├── server.ts        HTTP server: routes, control endpoints, catalog warm-up
├── proxy.ts         Routing: which provider, which model, error envelopes
├── openaiShim.ts    Anthropic ↔ OpenAI translation (pure functions)
├── stream.ts        OpenAI SSE → Anthropic event stream
├── catalog.ts       Model discovery + `claude-ccf-…` aliases
├── providers.ts     Multi-backend config
├── tokens.ts        Local token estimation
├── preflight.ts     Live backend verification
├── doctor.ts        `--doctor`
├── setup.ts         Setup wizard
├── modelpicker.ts   `--model`
├── switchpick.ts    `--switch`
├── env.ts           Config loading + loop guard
└── ui.ts            Terminal UI helpers
```

---

## Why listing models proves nothing

This bit is worth internalising, because it produces a failure that looks like something else entirely.

On several hosted backends — Ollama Cloud among them — the model listing endpoint is **public**:

```
GET  /v1/models          no auth header      → 200
GET  /v1/models          made-up key         → 200
POST /v1/chat/completions no auth            → 401
```

So any setup flow that validates by listing models will happily accept a placeholder key like `ollama`. The mistake surfaces much later, mid-conversation, as:

```
Failed to authenticate. API Error: 401 {"error":"Unauthorized"}
```

— which reads as *Claude Code's* login expiring, sending you to debug entirely the wrong thing.

claude-code-free handles this in three places: the wizard sends a real completion before writing config, `--doctor` does the same on demand, and the proxy wraps upstream 401s so the message names your backend and the responsible provider.

## Troubleshooting

**`claude-code-free: command not found`** — your npm global directory isn't on `PATH`. Find it with `npm prefix -g` and add it.

**`/model` shows no backend models** — check the proxy's startup log for `models: N across M backend(s)`. If a provider is named as not answering, run `claude-code-free --doctor`.

**401 mid-conversation** — your backend rejected its key. `claude-code-free --doctor` will name which provider and why.

**Model works in `--doctor` but not in Claude Code** — the model name in `.env` may not match what the backend serves. Ollama's local naming (`glm-5.2:cloud`) differs from the cloud API's (`glm-5.2`). `--doctor` reports the closest match.

**Blank replies from a reasoning model** — its token budget is being consumed by reasoning. Raise `max_tokens`, or set `CCF_MAX_OUTPUT_TOKENS` higher.

---

## Development

```bash
npm install
```

```bash
npm test
```

```bash
npm run typecheck
```

228 tests, entirely offline. Unit tests cover translation and config; `catalog-probe` stubs `fetch`; `proxy-routing` and `integration` run in-process mock backends; `server.test.ts` spawns the real proxy and drives every route over HTTP.

Run just the proxy, without Claude Code:

```bash
npm start
```

## Compatibility

Tested against Ollama (local and cloud). Anything exposing OpenAI-compatible `/models` and `/chat/completions` should work: OpenAI, DeepSeek, LM Studio, vLLM, llama.cpp, LiteLLM, OpenRouter, Together, Groq.

Verified with Claude Code **2.1.219**. Model discovery relies on Claude Code's gateway-discovery behaviour, which is version-dependent — if a future release changes it, `/model` may stop listing backend models while everything else keeps working.

## Licence

MIT — see [LICENSE.md](LICENSE.md).

claude-code-free is not affiliated with or endorsed by Anthropic. Claude Code is Anthropic's software, used here unmodified.
