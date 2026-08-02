#!/usr/bin/env node
// O.S.C.A.R. status line, rendered inside Claude Code's own UI.
//
// Claude Code supports a `statusLine` entry in settings.json:
//   { "statusLine": { "type": "command", "command": "<this file>" } }
// It runs the command, passes session JSON on stdin, and renders whatever the
// command prints at the bottom of the interface. That is the supported way to
// put our branding — and, more usefully, the live backend — in front of the
// user without touching Claude Code itself.
//
// Output looks like:
//   ⬢ O.S.C.A.R.  qwen2.5:7b via local  ·  ~/projects/app

import { basename } from "node:path";
import { homedir } from "node:os";

const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
};

/** Read the session payload Claude Code writes to stdin. Never blocks long. */
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    const timer = setTimeout(() => resolve(data), 250);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
  });
}

/** Ask the running proxy what it is actually routing to. */
async function activeBackend(port) {
  try {
    const res = await fetch(`http://localhost:${port}/_oscar/status`, {
      signal: AbortSignal.timeout(400),
    });
    if (!res.ok) return null;
    const s = await res.json();
    return {
      model: s.openaiModel ?? null,
      providers: Array.isArray(s.providers) ? s.providers.length : 1,
    };
  } catch {
    return null;
  }
}

/** `C:\Users\me\projects\app` → `~/projects/app`, trimmed to the tail. */
function shortPath(dir) {
  if (!dir) return "";
  const home = homedir();
  let p = dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;
  p = p.replace(/\\/g, "/");
  const parts = p.split("/").filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : p;
}

async function main() {
  const raw = await readStdin();
  let session = {};
  try {
    session = raw ? JSON.parse(raw) : {};
  } catch {
    /* Claude Code changed the payload shape; the brand still renders */
  }

  const port = process.env.PROXY_PORT || "8787";
  const backend = await activeBackend(port);

  const parts = [`${ANSI.cyan}⬢ ${ANSI.bold}O.S.C.A.R.${ANSI.reset}`];

  if (backend?.model) {
    const label =
      backend.providers > 1
        ? `${backend.model} ${ANSI.dim}(${backend.providers} backends)${ANSI.reset}`
        : backend.model;
    parts.push(`${ANSI.green}${label}${ANSI.reset}`);
  } else {
    // The proxy is not answering — say so rather than showing a stale model.
    parts.push(`${ANSI.yellow}proxy offline${ANSI.reset}`);
  }

  const dir = session?.workspace?.current_dir ?? session?.cwd ?? process.cwd();
  const short = shortPath(dir);
  if (short) parts.push(`${ANSI.dim}${short}${ANSI.reset}`);

  process.stdout.write(parts.join(`${ANSI.dim}  ·  ${ANSI.reset}`));
}

main().catch(() => {
  // A failing status line must never disrupt the session.
  process.stdout.write(`${ANSI.cyan}⬢ ${ANSI.bold}O.S.C.A.R.${ANSI.reset}`);
});

export { shortPath };
