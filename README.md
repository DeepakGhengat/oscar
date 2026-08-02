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
│   ├── catalog.ts             backend model list + `claude-ccf-…` aliases for /model
│   ├── tokens.ts              local estimator for /v1/messages/count_tokens
│   ├── openaiShim.ts          Anthropic ↔ OpenAI translation (tools, blocks, tool_use)
│   ├── stream.ts              OpenAI SSE stream → Anthropic event stream
│   ├── env.ts                 reads + validates the env flags
│   └── types.ts               shared interfaces (Anthropic + OpenAI shapes)
├── scripts/
│   ├── install-sdk.sh         vendors the installed @anthropic-ai/claude-code SDK here
│   ├── run.sh                 launches the proxy + claude together
│   └── run-tests.sh           runs the test suite
└── test/                      178 tests, all offline
    ├── cases.test.ts          core Anthropic ↔ OpenAI translation
    ├── shim-edge.test.ts      translation edge cases + token estimator
    ├── multimodal.test.ts     images, thinking blocks, max_tokens clamp
    ├── stream-edge.test.ts    SSE state machine: block pairing, tool calls
    ├── catalog.test.ts        /model alias table
    ├── catalog-probe.test.ts  backend probing + memoisation (stubbed fetch)
    ├── proxy-routing.test.ts  model resolution, upstream errors, passthrough
    ├── server.test.ts         every HTTP route, against a spawned proxy
    ├── env.test.ts            loadConfig: flags, URLs, validation, clamp
    ├── envfile.test.ts        .env parsing
    ├── env-loading.test.ts    .env precedence vs real environment
    ├── modelpicker.test.ts    surgical .env rewrites for --model / --switch
    ├── launcher.test.ts       version comparison + claude binary discovery
    ├── setup.test.ts          wizard presets and /models probing
    └── integration.test.ts    e2e through the real proxy + mock backend
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
| `CCF_MAX_OUTPUT_TOKENS` | Clamp on `max_tokens`. Claude Code asks for a 200k-context Claude model's budget; set this to your backend's real ceiling (e.g. `4096`) to stop it erroring or truncating mid-answer | unset (no clamp) |

## Switching models from `/model`

Every model your backend serves shows up in Claude Code's own `/model` picker,
so you can move between `glm-5.2:cloud`, `qwen2.5:7b`, `deepseek-v4-pro` and the
rest mid-session without restarting anything.

This works through Claude Code's **gateway model discovery**: at startup the CLI
fetches `$ANTHROPIC_BASE_URL/v1/models?limit=1000` and folds the result into the
picker. The launcher sets `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`; the
other preconditions (first-party provider, a base URL that isn't
`api.anthropic.com`) already hold when you run through the proxy.

One wrinkle: Claude Code discards any discovered id that doesn't match
`/^(claude|anthropic)/i`, which would drop every Ollama model on the floor. So
the proxy advertises each backend model under a `claude-ccf-…` alias and puts
the real name in `display_name` — which is what the picker actually renders. You
see `glm-5.2:cloud`; the CLI sends back `claude-ccf-glm-5.2-cloud`; the proxy
maps it home before calling the backend. See [`src/catalog.ts`](src/catalog.ts).

Two other ways to switch, both still available:

```bash
claude-code-free --model    # pick a model, write it to .env, then relaunch
claude-code-free --switch   # hot-swap a *running* proxy from a second terminal
```

## Checking your setup

```bash
claude-code-free --doctor
```

Verifies the config end to end and exits non-zero if anything is wrong.

It exists because one failure mode is nearly undiagnosable otherwise: on
hosted backends like Ollama Cloud the `/models` listing is **public** — it
answers `200` with no key at all, and `200` with a made-up one. A placeholder
key such as `ollama` therefore passes every reachability check and only fails
later, mid-conversation, as a `401` that reads like *Claude Code's* login
expiring rather than your backend refusing `OPENAI_API_KEY`. `--doctor` sends
a real one-token completion, which is the only check that distinguishes the
two. The setup wizard now runs the same check before writing `.env`.

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

Everything runs offline. Unit tests cover the translation and config logic;
`catalog-probe` stubs `globalThis.fetch`; `proxy-routing` and `integration`
spin up in-process mock backends; `server.test.ts` spawns the real
`src/server.ts` as a child process and drives every route over HTTP.