#!/usr/bin/env bash
# Start the proxy, then launch the bundled CLI pointing at it.
# Requires the SDK to be installed via scripts/install-sdk.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PROXY_PORT:-8787}"

# Run the interactive setup wizard on first run or when --setup is passed.
SETUP_FLAG=0
for arg in "$@"; do [ "$arg" = "--setup" ] && SETUP_FLAG=1; done
if [ ! -f "$ROOT/.env" ] || [ "$SETUP_FLAG" = "1" ]; then
  echo "Running setup wizard ..."
  npx tsx "$ROOT/src/setup.ts" || true
  # If the wizard already started the proxy, .env exists but we still continue
  # to launch the CLI below against the (possibly already-running) proxy.
fi

# Locate the CLI. The SDK ships as a native binary (bin/claude / claude.exe);
# fall back to whatever is on PATH.
CLI_BIN=""
if [ -x "$ROOT/sdk/bin/claude" ]; then
  CLI_BIN="$ROOT/sdk/bin/claude"
elif [ -x "$ROOT/sdk/bin/claude.exe" ]; then
  CLI_BIN="$ROOT/sdk/bin/claude.exe"
fi
if [ -z "$CLI_BIN" ]; then
  if command -v claude >/dev/null 2>&1; then
    CLI_BIN="$(command -v claude)"
  else
    echo "CLI not found. Run: bash scripts/install-sdk.sh" >&2
    exit 1
  fi
fi

# Validate required env when OpenAI routing is on.
if [ "${USE_OPENAI_API:-0}" = "1" ]; then
  : "${USE_OPENAI_API:?USE_OPENAI_API=1 requires a value}"
  : "${OPENAI_API_KEY:?OPENAI_API_KEY is required when USE_OPENAI_API=1}"
  : "${OPENAI_MODEL:?OPENAI_MODEL is required when USE_OPENAI_API=1}"
fi

# 1. Start proxy in background.
echo "Starting proxy on port $PORT ..."
npx tsx "$ROOT/src/server.ts" &
PROXY_PID=$!

cleanup() {
  kill "$PROXY_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 2. Wait for health.
for _ in $(seq 1 20); do
  if curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.25
done

# 3. Launch the CLI pointed at the proxy.
export ANTHROPIC_BASE_URL="http://localhost:$PORT"
# Keep the real Anthropic key available for passthrough mode (set OSCAR_UPSTREAM_BASE_URL
# if you want passthrough to hit a non-default Anthropic endpoint).
export OSCAR_UPSTREAM_BASE_URL="https://api.anthropic.com"
if [ "${USE_OPENAI_API:-0}" = "1" ]; then
  export ANTHROPIC_API_KEY="oscar-dummy-key"
  # Make backend models appear in /model: the CLI only fetches
  # $ANTHROPIC_BASE_URL/v1/models for the picker when this is set.
  export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
  # The CLI prefers stored OAuth credentials over the env-var key, so an expired
  # token in the real ~/.claude makes it ignore our dummy key and show a login
  # page. Point it at a throwaway profile — same location the Node launcher
  # uses, so both entry points share one clean config.
  CLEAN_CONFIG="${HOME}/.oscar/cli-profile"
  mkdir -p "$CLEAN_CONFIG"
  export CLAUDE_CONFIG_DIR="$CLEAN_CONFIG"
fi

echo "Launching: $CLI_BIN"
exec "$CLI_BIN" "$@"