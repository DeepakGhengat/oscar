---
description: Start the oscar proxy and launch the Claude Code CLI against it.
---

# Run Free

Starts the local translation proxy and launches the bundled `claude` CLI
pointed at it, so Claude Code drives an OpenAI-compatible backend.

## Usage

```bash
bash scripts/run.sh
```

## Prerequisites

- The Claude Code SDK is installed (`sdk/bin/claude` or `claude` on `PATH`).
  If missing, run `bash scripts/install-sdk.sh` first.
- `npm install` has been run in this directory.

## Environment

Set these before running if you want OpenAI routing (translation mode):

```bash
export USE_OPENAI_API=1
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=deepseek-chat
export OPENAI_BASE_URL=https://api.deepseek.com/v1
```

If `USE_OPENAI_API` is unset, the proxy passes through to the real Anthropic
endpoint using `ANTHROPIC_API_KEY`.

## What happens

1. The proxy starts on `$PROXY_PORT` (default `8787`).
2. `ANTHROPIC_BASE_URL` is pointed at the proxy.
3. The `claude` CLI is exec'd with any args you passed through.