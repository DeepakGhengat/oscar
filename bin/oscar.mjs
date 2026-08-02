#!/usr/bin/env node
// Global launcher for oscar.
// Cross-platform Node replacement for scripts/run.ps1 + scripts/run.sh.
//
// Flow:
//   1. Resolve config dir (~/.oscar, or $OSCAR_CONFIG)
//   2. Load .env from there into the process environment
//   3. Handle `--setup`: run the wizard and exit
//   4. Refuse to launch without config
//   5. Start the proxy (src/server.ts via tsx) as a child process
//   6. Wait for /healthz
//   7. Set ANTHROPIC_BASE_URL + dummy key + clean CLAUDE_CONFIG_DIR
//   8. Launch the coding CLI, forwarding remaining args
//   9. Tear down the proxy on exit

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
// Package root: bin/ -> ../  (where src/ and node_modules/ live)
const PKG_ROOT = resolve(dirname(__filename), "..");

// Placeholder credential handed to the CLI. The proxy ignores it and
// authenticates to the backend with the provider's own key.
const DUMMY_KEY = "oscar-dummy-key";

/** Is the CLI signing itself in against the vendor cloud, rather than us
 * holding an API key? Mirrors resolveUpstreamAuth() in src/env.ts: an explicit
 * OSCAR_AUTH wins, otherwise no key configured means the CLI must be. */
export function isSubscriptionAuth(env = process.env) {
  if (isTruthy(env.USE_OPENAI_API)) return false;
  const declared = (env.OSCAR_AUTH ?? "").trim().toLowerCase();
  if (["subscription", "oauth", "sso", "login"].includes(declared)) return true;
  if (["api-key", "apikey", "key"].includes(declared)) return false;
  return !(env.ANTHROPIC_API_KEY ?? "").trim();
}

/* --------------------------- config location ----------------------------- */

function configDir() {
  if (process.env.OSCAR_CONFIG) return process.env.OSCAR_CONFIG;
  return join(homedir(), ".oscar");
}

function envPath() {
  return join(configDir(), ".env");
}

export function parseEnvFile(content) {
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
export function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Newest `<root>/<version>/<exe>` under a versioned install root, or null. */
export function newestVersioned(root, exe) {
  if (!existsSync(root)) return null;
  let best = null;
  for (const name of readdirSync(root)) {
    if (!/^\d+\.\d+\.\d+/.test(name)) continue;
    if (!existsSync(join(root, name, exe))) continue;
    if (!best || compareVersions(name, best) > 0) best = name;
  }
  return best ? { path: join(root, best, exe), version: best } : null;
}

/** Names the CLI can be installed under, most directly executable first.
 *
 * On Windows `npm i -g` writes a **`claude.cmd`** shim — there is no
 * `claude.exe` unless the standalone installer or the desktop app put one
 * there. Looking only for the .exe misses an npm install completely, and
 * fails as a bare ENOENT immediately after running the very install command
 * this tool suggests. */
export function cliExeNames(platform = process.platform) {
  return platform === "win32"
    ? ["claude.exe", "claude.cmd", "claude.bat", "claude"]
    : ["claude"];
}

/** First `<dir>/<name>` that exists across PATH, or null. We resolve this
 * ourselves rather than letting spawn do a bare PATH lookup, because spawn
 * only ever tries the one name we hand it. */
export function findOnPath(names, pathVar = process.env.PATH, platform = process.platform) {
  const sep = platform === "win32" ? ";" : ":";
  for (const raw of (pathVar ?? "").split(sep)) {
    const dir = raw.trim().replace(/^"|"$/g, "");
    if (!dir) continue;
    for (const name of names) {
      try {
        const p = join(dir, name);
        if (existsSync(p)) return p;
      } catch {
        // an unreadable or malformed PATH entry is not fatal
      }
    }
  }
  return null;
}

/** `.cmd` and `.bat` are scripts, not executables: CreateProcess cannot run
 * them, so Node needs a shell to launch an npm-installed CLI on Windows. */
export function needsShell(binPath, platform = process.platform) {
  return platform === "win32" && /\.(cmd|bat)$/i.test(binPath);
}

/** Quote an argument for cmd.exe. With `shell: true` Node concatenates the
 * command and args verbatim, so anything containing a space is our problem. */
export function quoteForShell(s) {
  return /[\s"&|<>^()]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s);
}

/** Locate the coding CLI. The desktop app ships its own versioned copy and
 * never puts it on PATH, so check that before giving up — otherwise a
 * desktop-only install fails to launch with a bare ENOENT.
 *
 * The install directories below are fixed by the CLI's own installer, not
 * chosen by us. */
function findCliBin() {
  const names = cliExeNames();

  for (const name of names) {
    const sdkBin = join(PKG_ROOT, "sdk", "bin", name);
    if (existsSync(sdkBin)) return { path: sdkBin, version: null, found: true };
  }

  const roots = [];
  if (process.env.APPDATA) roots.push(join(process.env.APPDATA, "Claude", "claude-code"));
  roots.push(join(homedir(), "AppData", "Roaming", "Claude", "claude-code"));
  roots.push(join(homedir(), "Library", "Application Support", "Claude", "claude-code"));
  roots.push(join(homedir(), ".config", "Claude", "claude-code"));
  for (const root of roots) {
    for (const name of names) {
      const found = newestVersioned(root, name);
      if (found) return { ...found, found: true };
    }
  }

  // npm's global bin. Normally on PATH, but a shell opened before the install
  // will not have picked it up yet — which is exactly when people hit this.
  const npmDirs = [];
  if (process.env.APPDATA) npmDirs.push(join(process.env.APPDATA, "npm"));
  npmDirs.push(join(homedir(), ".npm-global", "bin"), "/usr/local/bin");
  for (const dir of npmDirs) {
    for (const name of names) {
      const p = join(dir, name);
      if (existsSync(p)) return { path: p, version: null, found: true };
    }
  }

  const onPath = findOnPath(names);
  if (onPath) return { path: onPath, version: null, found: true };

  // Nothing resolved. Hand back the conventional name so spawn can still try,
  // but mark it so the failure message can be specific.
  return { path: names[0], version: null, found: false };
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

/* ------------------------------ branding ---------------------------------- */

const C = {
  reset: "[0m",
  dim: "[2m",
  bold: "[1m",
  cyan: "[36m",
};

/** Shown before Claude Code takes over the terminal. */
export function banner(lines) {
  const art = [
    "  ██████╗ ███████╗ ██████╗ █████╗ ██████╗ ",
    " ██╔═══██╗██╔════╝██╔════╝██╔══██╗██╔══██╗",
    " ██║   ██║███████╗██║     ███████║██████╔╝",
    " ██║   ██║╚════██║██║     ██╔══██║██╔══██╗",
    " ╚██████╔╝███████║╚██████╗██║  ██║██║  ██║",
    "  ╚═════╝ ╚══════╝ ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝",
  ];
  const out = [""];
  for (const l of art) out.push(`${C.cyan}${l}${C.reset}`);
  out.push(`${C.dim} Orchestrator for System Coding & Autonomous Routing${C.reset}`);
  out.push("");
  for (const l of lines) out.push(` ${l}`);
  out.push("");
  return out.join("\n");
}

/** Set the terminal window/tab title, so the window reads O.S.C.A.R. too. */
function setTerminalTitle(title) {
  if (!process.stdout.isTTY) return;
  process.stdout.write(`]0;${title}`);
}

/** Pre-seed the throwaway Claude Code profile.
 *
 * Two reasons. First, a fresh profile means Claude Code runs its first-run
 * onboarding — the theme picker — on every launch, which is noise nobody asked
 * for. Second, `statusLine` is the supported hook for putting our own branding
 * and the live backend inside Claude Code's interface.
 *
 * Existing values are preserved: this only fills in what is missing, so a user
 * who sets their own theme or status line keeps it. */
export function seedClaudeProfile(dir, statusLineCmd) {
  const settingsPath = join(dir, "settings.json");
  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      settings = {};
    }
  }
  let changed = false;
  if (settings.theme === undefined) {
    settings.theme = "dark";
    changed = true;
  }
  if (settings.statusLine === undefined && statusLineCmd) {
    settings.statusLine = { type: "command", command: statusLineCmd };
    changed = true;
  }
  if (changed) writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  // hasCompletedOnboarding lives in .claude.json, not settings.json.
  const claudeJson = join(dir, ".claude.json");
  let data = {};
  if (existsSync(claudeJson)) {
    try {
      data = JSON.parse(readFileSync(claudeJson, "utf8"));
    } catch {
      data = {};
    }
  }
  if (data.hasCompletedOnboarding !== true) {
    data.hasCompletedOnboarding = true;
    writeFileSync(claudeJson, JSON.stringify(data, null, 2) + "\n");
  }
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
    process.env.OSCAR_CONFIG = dir;
    const tsx = findTsx();
    const setupTs = join(PKG_ROOT, "src", "setup.ts");
    if (tsx) {
      await runNode([tsx, setupTs], { stdio: "inherit" });
    } else {
      await runNode(["tsx", setupTs], { stdio: "inherit", useNpx: true });
    }
    process.exit(process.env.OSCAR_SETUP_EXIT ?? 0);
  }

  // --model: probe the configured backend, let the user pick a model,
  // rewrite OPENAI_MODEL in .env, then exit (re-run without --model to
  // launch). If --model is combined with other args, we still just switch
  // and exit — the user can launch separately.
  if (args.includes("--model")) {
    const dir = configDir();
    if (process.env.OSCAR_CONFIG === undefined) {
      process.env.OSCAR_CONFIG = dir;
    }
    const tsx = findTsx();
    const pickerTs = join(PKG_ROOT, "src", "modelpicker.ts");
    if (tsx) {
      await runNode([tsx, pickerTs], { stdio: "inherit" });
    } else {
      await runNode(["tsx", pickerTs], { stdio: "inherit", useNpx: true });
    }
    process.exit(process.env.OSCAR_SETUP_EXIT ?? 0);
  }

  // --doctor: check the config end to end (including a real completion, which
  // is the only way to catch a placeholder API key on a backend whose /models
  // listing is public) and exit.
  if (args.includes("--doctor")) {
    const dir = configDir();
    if (process.env.OSCAR_CONFIG === undefined) {
      process.env.OSCAR_CONFIG = dir;
    }
    const tsx = findTsx();
    const doctorTs = join(PKG_ROOT, "src", "doctor.ts");
    if (tsx) {
      await runNode([tsx, doctorTs], { stdio: "inherit" });
    } else {
      await runNode(["tsx", doctorTs], { stdio: "inherit", useNpx: true });
    }
    process.exit(Number(process.env.OSCAR_SETUP_EXIT ?? 0));
  }

  // --switch: talk to a *running* proxy's /_oscar/ control endpoints and
  // hot-swap the backend model live, without restarting the CLI. Use from a
  // second terminal while the CLI is running in the first.
  if (args.includes("--switch")) {
    const dir = configDir();
    if (process.env.OSCAR_CONFIG === undefined) {
      process.env.OSCAR_CONFIG = dir;
    }
    const tsx = findTsx();
    const switchTs = join(PKG_ROOT, "src", "switchpick.ts");
    if (tsx) {
      await runNode([tsx, switchTs], { stdio: "inherit" });
    } else {
      await runNode(["tsx", switchTs], { stdio: "inherit", useNpx: true });
    }
    process.exit(process.env.OSCAR_SETUP_EXIT ?? 0);
  }

  // Load config.
  loadEnv();
  if (!existsSync(envPath())) {
    console.error(
      `No config found at ${envPath()}.\n` +
      `Run 'oscar --setup' first to configure your backend.`,
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

  // Subscription sign-in: the CLI authenticates itself against the vendor
  // cloud — a Pro/Max/Team login, or enterprise SSO — using short-lived OAuth
  // credentials it refreshes on its own. Those live in the CLI's own config
  // (or the OS keychain), and nothing here can substitute for them.
  //
  // So we get out of the way completely: no proxy, no ANTHROPIC_BASE_URL
  // override, no throwaway CLAUDE_CONFIG_DIR, no injected key. `oscar` stays
  // the single entry point, and `/login`, SSO, Bedrock and Vertex all behave
  // exactly as they would without it.
  //
  // OSCAR_PROXY=1 opts back into routing through the proxy — useful for the
  // request log — and the proxy forwards the CLI's credentials untouched.
  if (isSubscriptionAuth() && !isTruthy(process.env.OSCAR_PROXY)) {
    console.log("Subscription sign-in: launching the CLI with its own credentials.");
    console.log(`${"Run /login inside the CLI if you are not signed in yet."}`);
    launchCli(args);
    return;
  }

  // 1. Start proxy.
  setTerminalTitle("O.S.C.A.R.");
  console.log(`${C.dim}Starting proxy on port ${port} ...${C.reset}`);
  const serverTs = join(PKG_ROOT, "src", "server.ts");
  const tsx = findTsx();
  const proxyArgs = tsx ? [tsx, serverTs] : [serverTs];
  const proxyCmd = tsx ? process.execPath : "npx";
  const proxySpawnArgs = tsx ? proxyArgs : ["tsx", ...proxyArgs];

  // Make sure the proxy loads the same config dir.
  const proxyEnv = { ...process.env, OSCAR_CONFIG: configDir() };
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
  console.log(`${C.dim}Proxy healthy on port ${port}.${C.reset}`);

  // 3. Point the CLI at the proxy.
  process.env.ANTHROPIC_BASE_URL = `http://localhost:${port}`;
  process.env.OSCAR_UPSTREAM_BASE_URL = "https://api.anthropic.com";
  if (isTruthy(process.env.USE_OPENAI_API)) {
    process.env.ANTHROPIC_API_KEY = DUMMY_KEY;
    // Make the backend's models show up in /model. The CLI only performs
    // gateway model discovery (GET $ANTHROPIC_BASE_URL/v1/models) when this is
    // set; the other preconditions — first-party provider and a base URL that
    // isn't api.anthropic.com — already hold here. The variable name is the
    // CLI's, not ours.
    process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
    // Bypass stored expired OAuth credentials so the env-var key is used.
    const cleanConfig = join(homedir(), ".oscar", "cli-profile");
    mkdirSync(cleanConfig, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = cleanConfig;
    seedClaudeProfile(cleanConfig, `node "${join(PKG_ROOT, "bin", "oscar-statusline.mjs")}"`);
    // The CLI persists API-key rejections into its state file, under
    // customApiKeyResponses.rejected[]. If a prior run rejected the dummy
    // key, it shows the login page instead of using the env var. Wipe any
    // rejected entries for our dummy key so each launch starts clean.
    const cliState = join(cleanConfig, ".claude.json");
    if (existsSync(cliState)) {
      try {
        const raw = readFileSync(cliState, "utf8");
        const data = JSON.parse(raw);
        let changed = false;
        if (data.customApiKeyResponses && Array.isArray(data.customApiKeyResponses.rejected)) {
          const filtered = data.customApiKeyResponses.rejected.filter(
            (k) => k !== DUMMY_KEY,
          );
          if (filtered.length !== data.customApiKeyResponses.rejected.length) {
            data.customApiKeyResponses.rejected = filtered;
            changed = true;
          }
        }
        if (changed) writeFileSync(cliState, JSON.stringify(data, null, 2));
      } catch {
        // corrupt or unreadable — let the CLI recreate it
      }
    }
  }

  // 4. Launch the CLI, forwarding args (minus any --setup we already handled).
  launchCli(args, killProxy, port);
}

/** Spawn the CLI with the environment as currently prepared, and mirror its
 * exit code. `onExit` tears down anything we started alongside it. */
function launchCli(args, onExit = () => {}, port) {
  const cliArgs = args.filter((a) => a !== "--setup" && a !== "--switch" && a !== "--doctor");
  const cliBin = findCliBin();

  if (!cliBin.found) {
    console.error(
      `Could not find the CLI. Looked for ${cliExeNames().join(", ")} in the ` +
      `bundled sdk/, the desktop app's install directories, npm's global bin, and on PATH.\n` +
      `Install it with: npm i -g @anthropic-ai/claude-code\n` +
      `If you just installed it, open a new terminal so PATH is refreshed.`,
    );
    onExit();
    process.exit(1);
  }

  // Full banner immediately before the CLI takes over the screen, so the
  // session opens under our name and states plainly what it routes to.
  setTerminalTitle("O.S.C.A.R.");
  const routing = isTruthy(process.env.USE_OPENAI_API)
    ? `${process.env.OPENAI_MODEL ?? "?"}  ${C.dim}via${C.reset}  ${process.env.OPENAI_BASE_URL ?? "?"}`
    : `${C.dim}passthrough — the CLI's own account${C.reset}`;
  const lines = [`${C.bold}routing${C.reset}   ${routing}`];
  if (port) lines.push(`${C.bold}proxy${C.reset}     http://localhost:${port}`);
  lines.push(`${C.bold}engine${C.reset}    ${cliBin.path}${cliBin.version ? ` (v${cliBin.version})` : ""}`);
  if (isTruthy(process.env.USE_OPENAI_API)) {
    lines.push("", `${C.dim}Type /model inside the session to switch backend model.${C.reset}`);
  }
  console.log(banner(lines));

  // An npm install on Windows is a .cmd shim. CreateProcess cannot execute
  // one, so it has to go through cmd.exe — and with `shell: true` Node stops
  // quoting arguments for us, so we do it ourselves.
  const useShell = needsShell(cliBin.path);
  const cli = useShell
    ? spawn([cliBin.path, ...cliArgs].map(quoteForShell).join(" "), {
        stdio: "inherit",
        env: process.env,
        shell: true,
      })
    : spawn(cliBin.path, cliArgs, { stdio: "inherit", env: process.env });

  cli.on("error", (err) => {
    console.error(
      `Could not launch the CLI (${cliBin.path}): ${err.message}\n` +
      `Install it with: npm i -g @anthropic-ai/claude-code`,
    );
    onExit();
    process.exit(1);
  });
  cli.on("exit", (code) => {
    onExit();
    process.exit(code ?? 0);
  });
}

/** Run node with given args; resolves with exit code via env var. */
function runNode(args, opts) {
  return new Promise((resolvePromise) => {
    const cmd = opts.useNpx ? (process.platform === "win32" ? "npx.cmd" : "npx") : process.execPath;
    const child = spawn(cmd, args, { stdio: opts.stdio || "inherit", env: process.env });
    child.on("exit", (code) => {
      process.env.OSCAR_SETUP_EXIT = String(code ?? 0);
      resolvePromise(code ?? 0);
    });
  });
}

/** Was this file run as the CLI, rather than imported?
 *
 * Compare *real* paths. A global install links the package into npm's
 * node_modules, so argv[1] arrives as the symlinked path while
 * import.meta.url resolves to the real one — comparing them directly makes
 * the global `oscar` command exit silently doing nothing. */
export function isCliEntry(argv1, self) {
  if (!argv1) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(argv1) === real(self);
}

// Importing this file (e.g. from tests) must not start a proxy or spawn the CLI.
if (isCliEntry(process.argv[1], __filename)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}