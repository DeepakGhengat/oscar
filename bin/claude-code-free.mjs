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

import { existsSync, mkdirSync, readFileSync } from "node:fs";
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

/** Locate the claude CLI: bundled SDK binary, else PATH. */
function findClaudeBin() {
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const sdkBin = join(PKG_ROOT, "sdk", "bin", exe);
  if (existsSync(sdkBin)) return sdkBin;
  // Rely on PATH lookup by spawning without an absolute path.
  return exe;
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
    // Bypass stored expired OAuth credentials so the env-var key is used.
    const cleanConfig = join(homedir(), ".claude-code-free", "claude-config");
    mkdirSync(cleanConfig, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = cleanConfig;
  }

  // 4. Launch claude, forwarding args (minus any --setup we already handled).
  const claudeArgs = args.filter((a) => a !== "--setup");
  const claudeBin = findClaudeBin();
  console.log(`Launching: ${claudeBin}`);
  const claude = spawn(claudeBin, claudeArgs, { stdio: "inherit", env: process.env });
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