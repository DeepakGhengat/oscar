#!/usr/bin/env node
// Global launcher for claude-code-free.
// Cross-platform Node replacement for scripts/run.ps1 + scripts/run.sh.
//
// Flow:
//   1. Resolve config dir (~/.claude-code-free, or $CLAUDE_CODE_FREE_CONFIG)
//   2. Load .env from there into the process environment
//   3. Handle `--setup`: run the wizard and exit
//   4. Refuse to launch without config
//   5. Start the proxy (src/server.ts via tsx) as a child process
//   6. Wait for /healthz
//   7. Set ANTHROPIC_BASE_URL + dummy key + clean CLAUDE_CONFIG_DIR
//   8. Launch the claude CLI, forwarding remaining args
//   9. Tear down the proxy on exit

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
// Package root: bin/ -> ../  (where src/ and node_modules/ live)
const PKG_ROOT = resolve(dirname(__filename), "..");

/* --------------------------- config location ----------------------------- */

function configDir() {
  if (process.env.CLAUDE_CODE_FREE_CONFIG) return process.env.CLAUDE_CODE_FREE_CONFIG;
  return join(homedir(), ".claude-code-free");
}

function envPath() {
  return join(configDir(), ".env");
}

function parseEnvFile(content) {
  const out = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** Load .env into process.env for keys not already set. */
function loadEnv() {
  const file = envPath();
  if (!existsSync(file)) return;
  const parsed = parseEnvFile(readFileSync(file, "utf8"));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

/* ------------------------------ helpers ----------------------------------- */

const TRUTHY = new Set(["1", "true", "yes", "on"]);
function isTruthy(v) {
  return v !== undefined && TRUTHY.has(v.trim().toLowerCase());
}

/** Compare two dotted version strings numerically: 2.1.219 > 2.1.99. */
function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Newest `<root>/<version>/<exe>` under a versioned install root, or null. */
function newestVersioned(root, exe) {
  if (!existsSync(root)) return null;
  let best = null;
  for (const name of readdirSync(root)) {
    if (!/^\d+\.\d+\.\d+/.test(name)) continue;
    if (!existsSync(join(root, name, exe))) continue;
    if (!best || compareVersions(name, best) > 0) best = name;
  }
  return best ? { path: join(root, best, exe), version: best } : null;
}

/** Locate the claude CLI. The Claude desktop app ships its own versioned
 * copy and never puts it on PATH, so check that before giving up — otherwise
 * a desktop-only install fails to launch with a bare ENOENT. */
function findClaudeBin() {
  const exe = process.platform === "win32" ? "claude.exe" : "claude";

  const sdkBin = join(PKG_ROOT, "sdk", "bin", exe);
  if (existsSync(sdkBin)) return { path: sdkBin, version: null };

  const roots = [];
  if (process.env.APPDATA) roots.push(join(process.env.APPDATA, "Claude", "claude-code"));
  roots.push(join(homedir(), "AppData", "Roaming", "Claude", "claude-code"));
  roots.push(join(homedir(), "Library", "Application Support", "Claude", "claude-code"));
  roots.push(join(homedir(), ".config", "Claude", "claude-code"));
  for (const root of roots) {
    const found = newestVersioned(root, exe);
    if (found) return found;
  }

  // Rely on PATH lookup by spawning without an absolute path.
  return { path: exe, version: null };
}

/** Find the tsx CLI shipped with the package. */
function findTsx() {
  const candidates = [
    join(PKG_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  // Fallback: let npx resolve it.
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(port, proxyProc) {
  const url = `http://localhost:${port}/healthz`;
  for (let i = 0; i < 40; i++) {
    if (proxyProc.exitCode !== null) {
      throw new Error(`Proxy exited early with code ${proxyProc.exitCode}`);
    }
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  return false;
}

/* ------------------------------- main ------------------------------------- */

async function main() {
  const args = process.argv.slice(2);

  // --setup: run the wizard against the config dir, then exit.
  if (args.includes("--setup")) {
    const dir = configDir();
    mkdirSync(dir, { recursive: true });
    process.env.CLAUDE_CODE_FREE_CONFIG = dir;
    const tsx = findTsx();
    const setupTs = join(PKG_ROOT, "src", "setup.ts");
    if (tsx) {
      await runNode([tsx, setupTs], { stdio: "inherit" });
    } else {
      await runNode(["tsx", setupTs], { stdio: "inherit", useNpx: true });
    }
    process.exit(process.env.CCF_SETUP_EXIT ?? 0);
  }

  // --model: probe the configured backend, let the user pick a model,
  // rewrite OPENAI_MODEL in .env, then exit (re-run without --model to
  // launch). If --model is combined with other args, we still just switch
  // and exit — the user can launch separately.
  if (args.includes("--model")) {
    const dir = configDir();
    if (process.env.CLAUDE_CODE_FREE_CONFIG === undefined) {
      process.env.CLAUDE_CODE_FREE_CONFIG = dir;
    }
    const tsx = findTsx();
    const pickerTs = join(PKG_ROOT, "src", "modelpicker.ts");
    if (tsx) {
      await runNode([tsx, pickerTs], { stdio: "inherit" });
    } else {
      await runNode(["tsx", pickerTs], { stdio: "inherit", useNpx: true });
    }
    process.exit(process.env.CCF_SETUP_EXIT ?? 0);
  }

  // --switch: talk to a *running* proxy's /_ccf/ control endpoints and
  // hot-swap the backend model live, without restarting claude. Use from a
  // second terminal while claude is running in the first.
  if (args.includes("--switch")) {
    const dir = configDir();
    if (process.env.CLAUDE_CODE_FREE_CONFIG === undefined) {
      process.env.CLAUDE_CODE_FREE_CONFIG = dir;
    }
    const tsx = findTsx();
    const switchTs = join(PKG_ROOT, "src", "switchpick.ts");
    if (tsx) {
      await runNode([tsx, switchTs], { stdio: "inherit" });
    } else {
      await runNode(["tsx", switchTs], { stdio: "inherit", useNpx: true });
    }
    process.exit(process.env.CCF_SETUP_EXIT ?? 0);
  }

  // Load config.
  loadEnv();
  if (!existsSync(envPath())) {
    console.error(
      `No config found at ${envPath()}.\n` +
      `Run 'claude-code-free --setup' first to configure your backend.`,
    );
    process.exit(1);
  }

  const port = process.env.PROXY_PORT || "8787";

  // Validate required env when OpenAI routing is on.
  if (isTruthy(process.env.USE_OPENAI_API)) {
    if (!process.env.OPENAI_API_KEY) {
      console.error("OPENAI_API_KEY is required when USE_OPENAI_API=1");
      process.exit(1);
    }
    if (!process.env.OPENAI_MODEL) {
      console.error("OPENAI_MODEL is required when USE_OPENAI_API=1");
      process.exit(1);
    }
  }

  // 1. Start proxy.
  console.log(`Starting proxy on port ${port} ...`);
  const serverTs = join(PKG_ROOT, "src", "server.ts");
  const tsx = findTsx();
  const proxyArgs = tsx ? [tsx, serverTs] : [serverTs];
  const proxyCmd = tsx ? process.execPath : "npx";
  const proxySpawnArgs = tsx ? proxyArgs : ["tsx", ...proxyArgs];

  // Make sure the proxy loads the same config dir.
  const proxyEnv = { ...process.env, CLAUDE_CODE_FREE_CONFIG: configDir() };
  const proxy = spawn(proxyCmd, proxySpawnArgs, {
    env: proxyEnv,
    stdio: "inherit",
    cwd: PKG_ROOT,
  });

  let proxyKilled = false;
  function killProxy() {
    if (proxyKilled) return;
    proxyKilled = true;
    try { proxy.kill("SIGTERM"); } catch {}
  }
  process.on("exit", killProxy);
  process.on("SIGINT", () => { killProxy(); process.exit(130); });
  process.on("SIGTERM", () => { killProxy(); process.exit(143); });

  // 2. Wait for health.
  const healthy = await waitForHealth(port, proxy);
  if (!healthy) {
    console.error(`Proxy did not become healthy on port ${port}`);
    killProxy();
    process.exit(1);
  }
  console.log(`Proxy healthy on port ${port}.`);

  // 3. Point the claude CLI at the proxy.
  process.env.ANTHROPIC_BASE_URL = `http://localhost:${port}`;
  process.env.ANTHROPIC_REAL_BASE_URL = "https://api.anthropic.com";
  if (isTruthy(process.env.USE_OPENAI_API)) {
    process.env.ANTHROPIC_API_KEY = "claude-code-free-dummy-key";
    // Make the backend's models show up in /model. Claude Code only performs
    // gateway model discovery (GET $ANTHROPIC_BASE_URL/v1/models) when this is
    // set; the other preconditions — first-party provider and a base URL that
    // isn't api.anthropic.com — already hold here.
    process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
    // Bypass stored expired OAuth credentials so the env-var key is used.
    const cleanConfig = join(homedir(), ".claude-code-free", "claude-config");
    mkdirSync(cleanConfig, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = cleanConfig;
    // claude persists API-key rejections into .claude.json's
    // customApiKeyResponses.rejected[]. If a prior run rejected the dummy
    // key, claude shows the login page instead of using the env var. Wipe
    // any rejected entries for our dummy key so each launch starts clean.
    const claudeJson = join(cleanConfig, ".claude.json");
    if (existsSync(claudeJson)) {
      try {
        const raw = readFileSync(claudeJson, "utf8");
        const data = JSON.parse(raw);
        let changed = false;
        if (data.customApiKeyResponses && Array.isArray(data.customApiKeyResponses.rejected)) {
          const filtered = data.customApiKeyResponses.rejected.filter(
            (k) => k !== "claude-code-free-dummy-key" && k !== "-code-free-dummy-key",
          );
          if (filtered.length !== data.customApiKeyResponses.rejected.length) {
            data.customApiKeyResponses.rejected = filtered;
            changed = true;
          }
        }
        if (changed) writeFileSync(claudeJson, JSON.stringify(data, null, 2));
      } catch {
        // corrupt or unreadable — let claude recreate it
      }
    }
  }

  // 4. Launch claude, forwarding args (minus any --setup we already handled).
  const claudeArgs = args.filter((a) => a !== "--setup" && a !== "--switch");
  const claudeBin = findClaudeBin();
  console.log(
    `Launching: ${claudeBin.path}${claudeBin.version ? ` (claude-code ${claudeBin.version})` : ""}`,
  );
  const claude = spawn(claudeBin.path, claudeArgs, { stdio: "inherit", env: process.env });
  claude.on("error", (err) => {
    console.error(
      `Could not launch the claude CLI (${claudeBin.path}): ${err.message}\n` +
      `Install it with: npm i -g @anthropic-ai/claude-code`,
    );
    killProxy();
    process.exit(1);
  });
  claude.on("exit", (code) => {
    killProxy();
    process.exit(code ?? 0);
  });
}

/** Run node with given args; resolves with exit code via env var. */
function runNode(args, opts) {
  return new Promise((resolvePromise) => {
    const cmd = opts.useNpx ? (process.platform === "win32" ? "npx.cmd" : "npx") : process.execPath;
    const child = spawn(cmd, args, { stdio: opts.stdio || "inherit", env: process.env });
    child.on("exit", (code) => {
      process.env.CCF_SETUP_EXIT = String(code ?? 0);
      resolvePromise(code ?? 0);
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});