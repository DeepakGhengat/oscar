#!/usr/bin/env bash
# Bring the installed CLI package (@anthropic-ai/claude-code) into this folder so the
# proxy + CLI can be run together. Tries npm global, then the standalone install.
set -euo pipefail

DEST="$(cd "$(dirname "$0")/.." && pwd)/sdk"
mkdir -p "$DEST"

# 1. npm global install
NPM_GLOBAL="$(npm root -g 2>/dev/null || true)"
SRC=""
if [ -n "$NPM_GLOBAL" ] && [ -d "$NPM_GLOBAL/@anthropic-ai/claude-code" ]; then
  SRC="$NPM_GLOBAL/@anthropic-ai/claude-code"
fi

# 2. Standalone install (~/.claude/local or version dirs). The npm package
#    ships as a directory; the standalone installer on Windows drops
#    claude.exe as a FILE in ~/.claude/local/ (no claude-code dir), so look
#    for both.
if [ -z "$SRC" ] && [ -d "$HOME/.claude" ]; then
  SRC="$(find "$HOME/.claude" -maxdepth 3 -type d -name 'claude-code' 2>/dev/null | head -n1)"
fi

# 3. Local node_modules
if [ -z "$SRC" ] && [ -d "./node_modules/@anthropic-ai/claude-code" ]; then
  SRC="./node_modules/@anthropic-ai/claude-code"
fi

if [ -z "$SRC" ]; then
  echo "ERROR: could not locate @anthropic-ai/claude-code." >&2
  echo "Install it first:  npm install -g @anthropic-ai/claude-code" >&2
  echo "   or via:          curl -fsSL https://claude.ai/install.sh | bash" >&2
  echo "   (Windows):       iwr https://claude.ai/install.ps1 | iex" >&2
  exit 1
fi

echo "Found the CLI at: $SRC"
cp -r "$SRC/." "$DEST/"
echo "Copied SDK into: $DEST"

# Surface the CLI binary into sdk/bin/ so run.sh can find it directly.
mkdir -p "$DEST/bin"
BIN=""
for cand in \
  "$DEST/bin/claude" "$DEST/bin/claude.exe" \
  "$DEST/cli.js" "$DEST/dist/cli.js" "$DEST/index.js"; do
  if [ -f "$cand" ]; then BIN="$cand"; break; fi
done
# Standalone Windows install: claude.exe lives in ~/.claude/local/, not in $SRC.
if [ -z "$BIN" ] || [ "$(basename "$BIN")" = "cli.js" ] || [ "$(basename "$BIN")" = "index.js" ]; then
  for cand in "$HOME/.claude/local/claude.exe" "$HOME/.claude/local/claude" "$HOME/.claude/claude.exe"; do
    if [ -f "$cand" ]; then cp -f "$cand" "$DEST/bin/$(basename "$cand")"; BIN="$DEST/bin/$(basename "$cand")"; break; fi
  done
fi

# Record the entry script (for run.sh's fallback) too.
ENTRY=""
for cand in "$DEST/cli.js" "$DEST/dist/cli.js" "$DEST/index.js"; do
  if [ -f "$cand" ]; then ENTRY="$cand"; break; fi
done
echo "$ENTRY" > "$DEST/.entry"
echo "Entry: $ENTRY"
echo "Binary: $BIN"
echo "Run with:  bash scripts/run.sh"