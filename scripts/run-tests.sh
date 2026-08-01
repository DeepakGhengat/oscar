#!/usr/bin/env bash
# Run all tests (unit + integration) on Node.js. No external network needed —
# integration tests spin up in-process mock servers on ephemeral ports.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec npx tsx --test "$ROOT/test/" "$@"