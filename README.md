# CLAUDE_CODE_FREE

Run Anthropic **Claude Code** against any **OpenAI-compatible** backend
(OpenAI, DeepSeek, local Ollama, LM Studio, vLLM, etc.) without modifying
Claude Code's source.

It works as a **local HTTP proxy**:

```
claude (Anthropic SDK)  ──►  this proxy (Anthropic /v1/messages)
                                   │  translates messages + tools
                                   ▼
                            OpenAI /v1/chat/completions  (OpenAI / DeepSeek / Ollama ...)
```

You point Claude Code at the proxy with one env var (`ANTHROPIC_BASE_URL`)
and enable OpenAI routing with `USE_OPENAI_API=1`. When the flag is off,
the proxy transparently forwards the request to the real Anthropic API,
so native functionality is never broken.

## Layout

```
CLAUDE_CODE_FREE/
├── README.md                  this file
├── package.json               scripts: start / dev / test / typecheck
├── tsconfig.json
├── .claude-plugin/
│   ├── plugin.json            single plugin: claude-code-free
│   └── marketplace.json       marketplace entry for the plugin
├── skills/claude-code-free/SKILL.md
├── commands/run-free.md       slash command: start proxy + claude
├── sdk/                       vendored @anthropic-ai/claude-code (types + CLI binary)
├── src/
│   ├── server.ts              Node http server: listens on a port, dispatches
│   ├── proxy.ts               routes /v1/messages → OpenAI or Anthropic passthrough
│   ├── openaiShim.ts          Anthropic ↔ OpenAI translation (tools, blocks, tool_use)
│   ├── stream.ts              OpenAI SSE stream → Anthropic event stream
│   ├── env.ts                 reads + validates the env flags
│   └── types.ts               shared interfaces (Anthropic + OpenAI shapes)
├── scripts/
│   ├── install-sdk.sh         vendors the installed @anthropic-ai/claude-code SDK here
│   ├── run.sh                 launches the proxy + claude together
│   └── run-tests.sh           runs the test suite
└── test/
    ├── cases.test.ts          translation unit tests (no network)
    └── integration.test.ts    e2e tests with in-process mock servers (no network)
```

This is a **plain Node.js** project — TypeScript runs via [`tsx`](https://github.com/privatenumber/tsx),
the server uses `node:http`, and tests use `node:test`. No Bun required.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `USE_OPENAI_API` | `1` enables OpenAI routing; anything else / unset → passthrough to Anthropic | unset (passthrough) |
| `OPENAI_API_KEY` | Bearer token for the OpenAI-compatible backend | required when flag on |
| `OPENAI_MODEL` | Model name sent to the backend (e.g. `gpt-4o`, `deepseek-chat`, `llama3.1`) | required when flag on |
| `OPENAI_BASE_URL` | Base URL of the backend | `https://api.openai.com/v1` |
| `ANTHROPIC_API_KEY` | Used only in passthrough mode (forwarded to real Anthropic) | — |
| `ANTHROPIC_BASE_URL` | **Set this to the proxy** so Claude Code talks to us | — |
| `PROXY_PORT` | Port the proxy listens on | `8787` |

## Quick start

Run the interactive setup wizard first — it asks which LLM provider to use
(OpenAI, DeepSeek, Ollama, LM Studio, vLLM, custom, or Anthropic passthrough),
collects your key/model, writes a `.env`, and offers to start the proxy:

```bash
npm install
npm run setup
```

Then bring the installed Claude Code SDK into this folder (one-time) and run:

```bash
# 1. (once) bring the installed Claude Code SDK into this folder
bash scripts/install-sdk.sh

# 2. run the proxy + claude together
bash scripts/run.sh
```

If `.env` is already present, `run.sh` skips the wizard and launches straight
into the proxy + CLI. Pass `--setup` to force the wizard: `bash scripts/run.sh --setup`.

Prefer to configure by hand? Set the env vars directly instead:

```bash
USE_OPENAI_API=1 \
OPENAI_API_KEY=sk-... \
OPENAI_MODEL=deepseek-chat \
OPENAI_BASE_URL=https://api.deepseek.com/v1 \
bash scripts/run.sh
```

`run.sh` starts the proxy on `PROXY_PORT`, then launches the bundled
`claude` CLI with `ANTHROPIC_BASE_URL=http://localhost:PROXY_PORT` so every
request flows through the shim.

## Running tests

```bash
bash scripts/run-tests.sh
# or directly: npx tsx --test test/
```

Unit tests cover the translation logic; integration tests spin up in-process
mock servers (no external network). Both run offline on Node.