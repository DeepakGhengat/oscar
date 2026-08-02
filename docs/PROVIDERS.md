# Providers

Configuring one backend, several backends, and the per-model knobs.

---

## One backend — `~/.oscar/.env`

Written by `oscar --setup`, editable by hand:

```bash
USE_OPENAI_API=1
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=ollama
OPENAI_MODEL=qwen2.5:7b
PROXY_PORT=8787
```

Setting `USE_OPENAI_API` to anything other than `1`/`true`/`yes`/`on` puts
O.S.C.A.R. in passthrough mode: every request goes to the real Anthropic API
untouched, using `ANTHROPIC_API_KEY`.

## Several backends — `~/.oscar/providers.json`

```json
{
  "providers": {
    "local": {
      "baseURL": "http://localhost:11434/v1",
      "apiKey": "ollama",
      "models": {
        "qwen2.5:7b": { "maxOutputTokens": 4096 }
      }
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

Every provider is probed in parallel at startup, and all their models land in
one `/model` picker:

```
qwen2.5:7b        (local)
llama3            (local)
glm-5.2           (cloud)
deepseek-chat     (deepseek)
```

Each request uses that provider's own base URL and key. Two providers serving
the same model name stay individually addressable.

### Fields

| Field | Required | Meaning |
|---|---|---|
| `baseURL` | yes | OpenAI-compatible root, e.g. `.../v1` |
| `apiKey` | no | Bearer token. Omit for a backend that needs none |
| `maxOutputTokens` | no | Ceiling for every model on this provider |
| `models` | no | Per-model overrides, keyed by real model id |

Provider ids must be alphanumeric plus `. _ -`. They appear in the picker, so
keep them short: `local`, `cloud`, `work`.

### Failure behaviour

A broken provider block is skipped with a reported error rather than taking
the proxy down. An unreachable provider contributes nothing to the picker and
is named in the startup log:

```
[warn] provider "cloud" did not answer /models — it will be missing from /model
```

If `providers.json` is unparseable, O.S.C.A.R. falls back to the flat `.env`.

---

## Token ceilings

Claude Code sizes `max_tokens` for a 200k-context Claude model. Smaller
backends either reject that outright or silently truncate mid-answer.

Ceilings resolve most-specific-first:

```
models[<model>].maxOutputTokens   →   provider.maxOutputTokens   →   OSCAR_MAX_OUTPUT_TOKENS
```

So a 4k local model and a 128k hosted one can coexist:

```json
{
  "providers": {
    "local":  { "baseURL": "http://localhost:11434/v1",
                "maxOutputTokens": 4096 },
    "cloud":  { "baseURL": "https://api.deepseek.com/v1", "apiKey": "sk-...",
                "maxOutputTokens": 65536 }
  }
}
```

---

## Known-good backends

| Backend | Base URL | Key |
|---|---|---|
| Ollama (local) | `http://localhost:11434/v1` | any placeholder |
| Ollama Cloud | `https://ollama.com/v1` | real key required |
| OpenAI | `https://api.openai.com/v1` | `sk-...` |
| DeepSeek | `https://api.deepseek.com/v1` | `sk-...` |
| LM Studio | `http://localhost:1234/v1` | any placeholder |
| vLLM | `http://localhost:8000/v1` | depends on launch flags |

Anything else exposing `/models` and `/chat/completions` in OpenAI format
should work — llama.cpp, LiteLLM, OpenRouter, Together, Groq.

### Ollama local vs. cloud naming

They differ, and it matters:

| | Local (`ollama list`) | Cloud (`/v1/models`) |
|---|---|---|
| Model id | `glm-5.2:cloud` | `glm-5.2` |

Putting the local-style name in a cloud config produces a confusing failure.
`oscar --doctor` reports the closest match when it spots one.

---

## Switching models

| Method | Scope | Restart? |
|---|---|---|
| `/model` inside Claude Code | that session | no |
| `oscar --switch` | the running proxy, from another terminal | no |
| `oscar --model` | rewrites `.env` | yes |

`/model` is the one you'll use. The other two exist for scripting and for
changing the default a fresh session starts with.

---

## Verifying

```bash
oscar --doctor
```

With several providers it checks each one separately, and always ends with a
real one-token completion — the only check that distinguishes a working key
from a placeholder, since many backends serve `/models` publicly.

```
✓ 2 providers configured

[local] http://localhost:11434/v1
✓ key: placeholder, fine for a local backend
✓ /models lists 10 model(s)
✓ live completion with qwen2.5:7b succeeded

[cloud] https://ollama.com/v1
✗ key is the placeholder "ollama", but this is a hosted backend that needs a real one
✗ live completion failed: rejected the API key (401)
```
