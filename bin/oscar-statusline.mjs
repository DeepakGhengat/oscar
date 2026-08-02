#!/usr/bin/env node
// O.S.C.A.R. status line, rendered inside the coding CLI's own UI.
//
// The CLI supports a `statusLine` entry in settings.json:
//   { "statusLine": { "type": "command", "command": "<this file>" } }
// It runs the command, passes session JSON on stdin, and renders whatever the
// command prints at the bottom of the interface.
//
// The session payload carries the model the session is actually on:
//   { model: { id, display_name }, workspace: { current_dir, project_dir } }
//
// That is the authority for "what is active". This used to report the proxy's
// configured OPENAI_MODEL instead, which is a different thing entirely: it is
// the *default* backend model, and it does not change when you pick something
// else from /model. So the line read `glm-5.2:cloud` while the session was on
// Opus 5 — most misleading in hybrid, where both are legitimate destinations.
//
// Output looks like:
//   ⬢ O.S.C.A.R.  ·  glm-5.2:cloud → cloud  ·  ~/projects/app
//   ⬢ O.S.C.A.R.  ·  Opus 5 → anthropic  ·  ~/projects/app

import { basename } from "node:path";
import { homedir } from "node:os";

const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  magenta: "\u001b[35m",
};

/** Read the session payload the CLI writes to stdin. Never blocks long. */
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

/** Ask the running proxy which backend models it advertises, so an alias can
 * be shown under its real name and provider. Null when no proxy is running —
 * which is normal in account-sign-in mode, not an error. */
async function catalog(port) {
  try {
    const res = await fetch(`http://localhost:${port}/_oscar/models`, {
      signal: AbortSignal.timeout(400),
    });
    if (!res.ok) return null;
    const s = await res.json();
    return {
      entries: Array.isArray(s.entries) ? s.entries : [],
      providers: new Set((Array.isArray(s.entries) ? s.entries : []).map((e) => e.provider)).size,
    };
  } catch {
    return null;
  }
}

/** What the session is on, and where that goes.
 *
 * `model` is whatever the CLI reports for this session — the live selection,
 * not a config default. The destination is resolved from the proxy's own alias
 * table when one is reachable. */
export function describeActive(session, cat) {
  const id = session?.model?.id ?? null;
  const shown = session?.model?.display_name || id;
  if (!shown) return null;

  const entry = cat?.entries?.find((e) => e.alias === id || e.model === id);
  if (entry) {
    return { label: entry.model, via: entry.provider, backend: true };
  }
  // Not one of ours. With a proxy running that means hybrid sent it to the
  // vendor; without one, the CLI is talking to the vendor directly anyway.
  return { label: shown, via: "anthropic", backend: false };
}

/** `C:\Users\me\projects\app` → `~/projects/app`, trimmed to the tail. */
export function shortPath(dir) {
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
    /* the payload shape changed; the brand still renders */
  }

  const port = process.env.PROXY_PORT || "8787";
  const cat = await catalog(port);
  const active = describeActive(session, cat);

  const parts = [`${ANSI.cyan}⬢ ${ANSI.bold}O.S.C.A.R.${ANSI.reset}`];

  if (active) {
    const colour = active.backend ? ANSI.green : ANSI.magenta;
    const suffix = cat ? `${ANSI.dim} → ${active.via}${ANSI.reset}` : "";
    parts.push(`${colour}${active.label}${ANSI.reset}${suffix}`);
    if (active.backend && cat && cat.providers > 1) {
      parts.push(`${ANSI.dim}${cat.providers} backends${ANSI.reset}`);
    }
  } else if (!cat) {
    // No model in the payload and no proxy to ask: say nothing rather than
    // invent a state.
    parts.push(`${ANSI.dim}ready${ANSI.reset}`);
  } else {
    parts.push(`${ANSI.yellow}no model${ANSI.reset}`);
  }

  const dir = session?.workspace?.current_dir ?? session?.cwd ?? process.cwd();
  const short = shortPath(dir);
  if (short) parts.push(`${ANSI.dim}${short}${ANSI.reset}`);

  process.stdout.write(parts.join(`${ANSI.dim}  ·  ${ANSI.reset}`));
}

const invokedAs = process.argv[1] ?? "";
if (invokedAs.endsWith("oscar-statusline.mjs")) {
  main().catch(() => {
    // A failing status line must never disrupt the session.
    process.stdout.write(`${ANSI.cyan}⬢ ${ANSI.bold}O.S.C.A.R.${ANSI.reset}`);
  });
}
