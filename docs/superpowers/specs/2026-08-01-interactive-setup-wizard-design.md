# Interactive Setup Wizard — Design

**Date:** 2026-08-01
**Status:** Approved (pending user spec review)

## Goal

Replace manual env-var editing with a guided, interactive first-run setup — mirroring the
OpenClaude (`@gitlawb/openclaude`) setup prompt that asks which LLM provider to use, collects
the needed values, writes config, and launches the proxy.

## Non-goals

- Editing an existing `.env` in place (the wizard overwrites after confirming — fresh-setup
  intent). A `--reset` flag is a future concern.
- Storing config outside the repo (option A chosen: `.env` in project root).
- New runtime dependencies. The wizard uses only `node:readline` + global `fetch`.

## Files

- **`src/setup.ts`** (new) — the interactive wizard. Arrow-key provider menu, collects
  key/model/base URL, probes local endpoints for available models, writes `.env`, offers to
  start the proxy.
- **`src/env.ts`** (edited) — load `.env` at process start so the proxy picks up the wizard's
  output. A small `loadEnvFile()` helper at the top of the module sets `process.env` for keys
  not already set. Called once before `loadConfig()`.
- **`scripts/run.sh`** (edited) — if `.env` is missing OR `--setup` is passed, run
  `npx tsx src/setup.ts` before starting the proxy.
- **`package.json`** (edited) — add `"setup": "tsx src/setup.ts"`.
- **`.gitignore`** (edited) — ensure `.env` is ignored.

## Provider presets

Each preset is a partial config (base URL + default model + key hint); the user still enters
the real key and may override the model.

| # | Provider | `OPENAI_BASE_URL` | Default model | Key |
|---|---|---|---|---|
| 1 | OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | user enters |
| 2 | DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | user enters |
| 3 | Ollama (local) | `http://localhost:11434/v1` | `llama3` (probed) | `ollama` |
| 4 | LM Studio (local) | `http://localhost:1234/v1` | probed | `lm-studio` |
| 5 | vLLM (local) | `http://localhost:8000/v1` | probed | `vllm` |
| 6 | Custom OpenAI-compatible | user enters | user enters | user enters |
| 7 | Passthrough → Anthropic | n/a (no translation) | n/a | `ANTHROPIC_API_KEY` |

## Flow

1. Welcome banner.
2. Arrow-key provider menu (1–7 above).
3. Per selection:
   - **Cloud (OpenAI, DeepSeek):** prefill base URL + default model; prompt for API key
     (required, non-empty); allow model override.
   - **Local (Ollama, LM Studio, vLLM):** prefill base URL; **probe `GET /v1/models`** with a
     2s timeout. If reachable and returns models, show them as an arrow-key menu. If
     unreachable or timed out, fall back to manual model entry. Key defaults to the preset
     placeholder.
   - **Custom:** prompt for base URL, model, key.
   - **Passthrough:** prompt for `ANTHROPIC_API_KEY` only; sets no OpenAI vars
     (`USE_OPENAI_API` left unset).
4. Show a confirmation summary of the resolved config.
5. Write `.env` (`USE_OPENAI_API`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL`,
   `PROXY_PORT`, and `ANTHROPIC_API_KEY` for passthrough).
6. Ask: "Start the proxy now on port 8787? (Y/n)". If yes, spawn
   `npx tsx src/server.ts` as a child and stream its output (proxy takes over the terminal).

## Probing detail

`probeModels(baseURL: string): Promise<string[]>`

- `fetch(\`${baseURL}/models\`)` with `AbortSignal.timeout(2000)`.
- Parse `data[].id` from the OpenAI `/models` response shape.
- On any error or timeout → return `[]` → wizard shows the manual-entry fallback.
- Never blocks startup — purely an enhancement. An unreachable local server is not an error.

## `.env` loading

`loadEnvFile(path?: string): void`

- Reads `CLAUDE_CODE_FREE/.env` if present.
- Parses `KEY=VALUE` lines; skips blanks and `#` comments; strips surrounding quotes.
- Sets `process.env` **only for keys not already set** (explicit env wins over file — keeps
  tests deterministic).
- Guarded to run once (module-level flag).

`env.ts` calls `loadEnvFile()` at the top, before `loadConfig()` is first used.

## Error handling

- Empty/invalid input → re-prompt in a loop until valid.
- Ctrl+C / EOF → exit cleanly (readline `SIGINT`/`close`).
- Cloud provider with empty key → re-prompt (key required).
- `.env` write failure → print the path + error, exit 1.
- Probe failure → silent fallback to manual entry (no hard error).

## Testing

`test/setup.test.ts` — unit tests for the **pure helpers** (the readline loop is kept thin so
logic lives in testable functions):

- `probeModels` — inject a `fetch`-like function; assert timeout path returns `[]`, happy
  path returns parsed model ids, malformed JSON returns `[]`.
- `formatEnv(config)` — assert the exact `.env` string for a cloud config, a passthrough
  config, and a custom config (including `PROXY_PORT` default and quote handling).
- `PROVIDER_PRESETS` — assert the preset table matches the design table above.

Interactive readline behavior is not unit-tested (kept minimal, logic extracted into helpers).

## Out of scope

- In-place `.env` editing / `--reset` (future).
- User-level config file (option A chosen).
- Provider key validation against the live API (only non-empty check).