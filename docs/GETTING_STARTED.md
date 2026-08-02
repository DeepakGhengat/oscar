# Getting started with O.S.C.A.R.

Zero to a working setup, with nothing assumed. About ten minutes, most of it
waiting for a model to download.

---

## Step 1 — Check Node

```bash
node --version
```

Needs to be **18 or higher**. If it isn't, install from [nodejs.org](https://nodejs.org).

## Step 2 — Get a backend running

The easiest is [Ollama](https://ollama.com). Install it, then:

```bash
ollama pull qwen2.5:7b
```

That's a 4.7 GB download. Confirm it worked:

```bash
ollama list
```

Ollama serves an OpenAI-compatible API at `http://localhost:11434/v1` whenever
it's running. Nothing else to configure.

> Already have OpenAI, DeepSeek, LM Studio or vLLM? Skip this — any of them work.

## Step 3 — Check the CLI

O.S.C.A.R. drives the CLI; it doesn't replace it.

```bash
claude --version
```

If that fails but you have the desktop app, you're still fine — O.S.C.A.R.
finds the copy the desktop app bundles. Otherwise:

```bash
npm install -g @anthropic-ai/claude-code
```

## Step 4 — Install O.S.C.A.R.

```bash
git clone https://github.com/DeepakGhengat/oscar.git
```

```bash
cd oscar
```

```bash
npm pack
```

```bash
npm install -g ./oscar-0.1.0.tgz
```

```bash
rm oscar-0.1.0.tgz
```

Check it registered:

```bash
oscar --doctor
```

You should see it complain that there's no config yet. That's the right answer
at this point.

## Step 5 — Configure

```bash
oscar --setup
```

Answer as follows:

| Prompt | Answer |
|---|---|
| Choose an LLM provider | **Ollama (local)** |
| Proxy port | press Enter for `8787` |
| Base URL | press Enter for `http://localhost:11434/v1` |
| API key | press Enter — local Ollama ignores it |
| Pick a model | `qwen2.5:7b` |

The wizard then sends one real request to confirm the backend answers, and
writes `~/.oscar/.env`.

## Step 6 — Verify

```bash
oscar --doctor
```

You want:

```
✓ config file present
✓ key: placeholder, fine for a local backend
✓ /models lists N model(s)
✓ live completion with qwen2.5:7b succeeded

All checks passed.
```

If anything is red, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Step 7 — Run it

```bash
oscar
```

The CLI starts as normal. Type `/model` and your Ollama models are in the
list. Pick one and start working.

To check without entering the UI:

```bash
oscar -p "what files are in this directory?"
```

---

## What to do next

**Add a second backend.** Create `~/.oscar/providers.json` and both appear in
one picker — see [PROVIDERS.md](PROVIDERS.md).

**Cap output tokens.** If a small model truncates or errors, add
`OSCAR_MAX_OUTPUT_TOKENS=4096` to `~/.oscar/.env`. The CLI asks for a
200k-context budget by default, which small models can't honour.

**Switch models without restarting.** Use `/model` inside the CLI, or run
`oscar --switch` from a second terminal while it's running.

---

## A realistic expectation

A 7B local model is not a frontier model. It will be slower, will sometimes ignore tool
schemas, and will handle long contexts worse. For quick edits, file questions
and offline work it's genuinely useful. For complex multi-step refactors, a
larger hosted model behind O.S.C.A.R. will serve you better.

The point of O.S.C.A.R. is that switching between them is one keystroke.
