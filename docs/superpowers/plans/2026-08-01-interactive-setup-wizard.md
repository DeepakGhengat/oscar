# Interactive Setup Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a guided, interactive first-run setup wizard (`npx tsx src/setup.ts`) that asks which LLM provider to use, collects the needed values, writes a `.env` file, and offers to start the proxy — mirroring the OpenClaude setup experience.

**Architecture:** A new `src/setup.ts` CLI built on `node:readline` (no new deps) holds a thin interactive loop; all testable logic lives in pure helpers (`PROVIDER_PRESETS`, `probeModels`, `formatEnv`, `loadEnvFile`) inside the same module and a small `src/envfile.ts` loader. `src/env.ts` calls `loadEnvFile()` once at startup so the proxy picks up the wizard's `.env`. `scripts/run.sh` runs the wizard when `.env` is missing or `--setup` is passed.

**Tech Stack:** Node 18+ (global `fetch`, `AbortSignal.timeout`), `node:readline/promises`, `node:tty`, `tsx`, `node:test`.

## Global Constraints

- No new runtime dependencies — only `node:readline`, `node:readline/promises`, `node:fs`, `node:path`, global `fetch`.
- TypeScript strict mode (project `tsconfig.json` already enforces this); no `any` without justification.
- `.env` is the single source of persisted config (option A from brainstorming).
- Explicit env vars win over `.env` (so tests stay deterministic).
- Local-endpoint probing uses a 2s timeout and never blocks startup on failure.
- All new files use the project's existing ESM + `.ts` extension imports style (`import ... from "./x.ts"`).

---

## File Structure

- **`src/envfile.ts`** (new) — `loadEnvFile(path?: string): void` + `parseEnvFile(content: string): Record<string, string>`. Pure-ish: reads the file and mutates `process.env` for missing keys. Guarded to run once.
- **`src/setup.ts`** (new) — the wizard. Exports the pure helpers (`PROVIDER_PRESETS`, `probeModels`, `formatEnv`) for testing, plus a `main()` that runs the interactive loop. Default entry runs `main()`.
- **`src/env.ts`** (modify) — import + call `loadEnvFile()` once at module top.
- **`scripts/run.sh`** (modify) — run the wizard when `.env` missing or `--setup` passed.
- **`package.json`** (modify) — add `"setup": "tsx src/setup.ts"`.
- **`.gitignore`** (modify) — add `.env`.
- **`test/setup.test.ts`** (new) — unit tests for the pure helpers.
- **`test/envfile.test.ts`** (new) — unit tests for `parseEnvFile` / `loadEnvFile`.

---

### Task 1: `.env` parser/loader (`src/envfile.ts`)

**Files:**
- Create: `src/envfile.ts`
- Test: `test/envfile.test.ts`

**Interfaces:**
- Produces:
  - `parseEnvFile(content: string): Record<string, string>` — parse `KEY=VALUE` text into a plain object. Skips blank lines and lines whose first non-space char is `#`. Strips a single pair of surrounding `"` or `'` from values. Does not mutate `process.env`.
  - `loadEnvFile(path?: string): void` — default path `<cwd>/.env`. If the file is missing, no-op. Otherwise parses it and sets `process.env[k] = v` **only for keys not already set**. Guarded by a module-level `Set<string>` of already-loaded paths so repeated calls are no-ops.

- [ ] **Step 1: Write the failing test**

Create `test/envfile.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvFile, loadEnvFile } from "../src/envfile.ts";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("parseEnvFile: skips blanks and comments, strips quotes", () => {
  const out = parseEnvFile([
    "# a comment",
    "",
    "FOO=bar",
    'QUOTED="hello world"',
    "SINGLE='single quoted'",
    "  SPACED = spaced  ",
  ].join("\n"));
  assert.deepEqual(out, {
    FOO: "bar",
    QUOTED: "hello world",
    SINGLE: "single quoted",
    SPACED: "spaced",
  });
});

test("parseEnvFile: empty content yields empty object", () => {
  assert.deepEqual(parseEnvFile(""), {});
});

test("loadEnvFile: sets missing keys, leaves existing env untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "envfile-"));
  const file = join(dir, ".env");
  writeFileSync(file, "WIZ_TEST_NEW=1\nWIZ_TEST_EXISTING=fromfile\n");
  process.env.WIZ_TEST_EXISTING = "fromenv";
  delete process.env.WIZ_TEST_NEW;
  try {
    loadEnvFile(file);
    assert.equal(process.env.WIZ_TEST_NEW, "1");
    assert.equal(process.env.WIZ_TEST_EXISTING, "fromenv"); // existing wins
  } finally {
    delete process.env.WIZ_TEST_NEW;
    delete process.env.WIZ_TEST_EXISTING;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadEnvFile: missing file is a no-op (no throw)", () => {
  assert.doesNotThrow(() => loadEnvFile(join(tmpdir(), "definitely-not-here.env")));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/tsx/dist/cli.mjs --test test/envfile.test.ts`
Expected: FAIL — `Cannot find module '../src/envfile.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/envfile.ts`:

```typescript
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const loaded = new Set<string>();

/** Parse KEY=VALUE text into a plain object. No side effects. */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
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

/** Load .env into process.env for keys not already set. Runs once per path. */
export function loadEnvFile(path?: string): void {
  const file = resolve(path ?? ".env");
  if (loaded.has(file)) return;
  loaded.add(file);
  if (!existsSync(file)) return;
  const parsed = parseEnvFile(readFileSync(file, "utf8"));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/tsx/dist/cli.mjs --test test/envfile.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/envfile.ts test/envfile.test.ts
git commit -m "feat: add .env parser/loader (envfile module)"
```

---

### Task 2: Wire `.env` loading into `src/env.ts`

**Files:**
- Modify: `src/env.ts` (add import + single call at module top)

**Interfaces:**
- Consumes: `loadEnvFile` from `src/envfile.ts` (Task 1).
- Produces: `loadConfig()` now sees `.env` values for any key not set in the real environment.

- [ ] **Step 1: Write the failing test**

Create `test/env-loading.test.ts`:

```typescript
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// loadConfig reads process.env at call time, so a freshly-written .env in cwd
// is picked up after the module-level loadEnvFile() runs on import.
// We force re-import by using a dynamic import with a cache-busting query.

let prevCwd: string;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "envload-"));
  prevCwd = process.cwd();
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

test("loadConfig picks up .env in cwd for unset keys", async () => {
  writeFileSync(join(dir, ".env"), "PROXY_PORT=9999\nUSE_OPENAI_API=0\n");
  delete process.env.PROXY_PORT;
  delete process.env.USE_OPENAI_API;
  // bust tsx/esmlr module cache
  const mod = await import(`../src/env.ts?t=${Date.now()}`);
  const cfg = mod.loadConfig();
  assert.equal(cfg.port, 9999);
  assert.equal(cfg.useOpenAI, false);
});

test("real env wins over .env", async () => {
  writeFileSync(join(dir, ".env"), "PROXY_PORT=1111\n");
  process.env.PROXY_PORT = "2222";
  try {
    const mod = await import(`../src/env.ts?t=${Date.now()}`);
    assert.equal(mod.loadConfig().port, 2222);
  } finally {
    delete process.env.PROXY_PORT;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/tsx/dist/cli.mjs --test test/env-loading.test.ts`
Expected: FAIL — `cfg.port` is `8787` (default), not `9999`, because `loadEnvFile` is not yet called.

- [ ] **Step 3: Write minimal implementation**

Edit `src/env.ts` — add at the very top (above the existing `const TRUTHY = ...` line):

```typescript
import { loadEnvFile } from "./envfile.ts";

loadEnvFile();
```

The full top of the file becomes:

```typescript
import { loadEnvFile } from "./envfile.ts";
import type { ProxyConfig } from "./types.ts";

loadEnvFile();

const TRUTHY = new Set(["1", "true", "yes", "on"]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/tsx/dist/cli.mjs --test test/env-loading.test.ts`
Expected: PASS — 2 tests.

Then run the full suite to confirm no regressions:
Run: `node node_modules/tsx/dist/cli.mjs --test test/cases.test.ts`
Expected: PASS — 15 tests (existing, unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/env.ts test/env-loading.test.ts
git commit -m "feat: load .env at proxy startup (env wins over file)"
```

---

### Task 3: Provider presets + `formatEnv` (`src/setup.ts` pure helpers)

**Files:**
- Create: `src/setup.ts` (helpers only this task; interactive `main()` comes in Task 5)
- Test: `test/setup.test.ts`

**Interfaces:**
- Produces:
  - `type ProviderId = "openai" | "deepseek" | "ollama" | "lmstudio" | "vllm" | "custom" | "passthrough"`
  - `interface ProviderPreset { id: ProviderId; label: string; baseURL: string | null; defaultModel: string | null; keyHint: string | null; kind: "cloud" | "local" | "custom" | "passthrough" }`
  - `PROVIDER_PRESETS: ProviderPreset[]` — the 7 entries from the spec table.
  - `interface SetupConfig { useOpenAI: boolean; openAIKey: string | null; openAIModel: string | null; openAIBaseURL: string | null; anthropicKey: string | null; port: number }`
  - `formatEnv(cfg: SetupConfig): string` — returns the exact `.env` text. Always includes a `PROXY_PORT=` line. Includes OpenAI lines only when `useOpenAI`. Includes `ANTHROPIC_API_KEY` only when `anthropicKey` is non-null.

- [ ] **Step 1: Write the failing test**

Create `test/setup.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_PRESETS, formatEnv } from "../src/setup.ts";

test("PROVIDER_PRESETS: 7 presets with the expected ids and base URLs", () => {
  const ids = PROVIDER_PRESETS.map((p) => p.id);
  assert.deepEqual(ids, [
    "openai", "deepseek", "ollama", "lmstudio", "vllm", "custom", "passthrough",
  ]);
  const byId = Object.fromEntries(PROVIDER_PRESETS.map((p) => [p.id, p]));
  assert.equal(byId.openai.baseURL, "https://api.openai.com/v1");
  assert.equal(byId.openai.defaultModel, "gpt-4o-mini");
  assert.equal(byId.deepseek.baseURL, "https://api.deepseek.com/v1");
  assert.equal(byId.ollama.baseURL, "http://localhost:11434/v1");
  assert.equal(byId.lmstudio.baseURL, "http://localhost:1234/v1");
  assert.equal(byId.vllm.baseURL, "http://localhost:8000/v1");
  assert.equal(byId.custom.baseURL, null);
  assert.equal(byId.passthrough.kind, "passthrough");
});

test("formatEnv: cloud config writes OpenAI vars + port", () => {
  const out = formatEnv({
    useOpenAI: true,
    openAIKey: "sk-test",
    openAIModel: "gpt-4o-mini",
    openAIBaseURL: "https://api.openai.com/v1",
    anthropicKey: null,
    port: 8787,
  });
  assert.match(out, /USE_OPENAI_API=1/);
  assert.match(out, /OPENAI_API_KEY=sk-test/);
  assert.match(out, /OPENAI_MODEL=gpt-4o-mini/);
  assert.match(out, /OPENAI_BASE_URL=https:\/\/api\.openai\.com\/v1/);
  assert.match(out, /PROXY_PORT=8787/);
  assert.doesNotMatch(out, /ANTHROPIC_API_KEY/);
});

test("formatEnv: passthrough config writes only anthropic key + port", () => {
  const out = formatEnv({
    useOpenAI: false,
    openAIKey: null,
    openAIModel: null,
    openAIBaseURL: null,
    anthropicKey: "sk-ant",
    port: 8787,
  });
  assert.match(out, /ANTHROPIC_API_KEY=sk-ant/);
  assert.match(out, /PROXY_PORT=8787/);
  assert.doesNotMatch(out, /USE_OPENAI_API=1/);
  assert.doesNotMatch(out, /OPENAI_API_KEY/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/tsx/dist/cli.mjs --test test/setup.test.ts`
Expected: FAIL — `Cannot find module '../src/setup.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/setup.ts` (helpers only — `main()` added in Task 5):

```typescript
// Interactive setup wizard for oscar.
// Pure helpers are exported for testing; main() runs the interactive loop.

export type ProviderId =
  | "openai" | "deepseek" | "ollama" | "lmstudio" | "vllm" | "custom" | "passthrough";

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  baseURL: string | null;
  defaultModel: string | null;
  keyHint: string | null;
  kind: "cloud" | "local" | "custom" | "passthrough";
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "openai",      label: "OpenAI",                baseURL: "https://api.openai.com/v1",  defaultModel: "gpt-4o-mini", keyHint: null,         kind: "cloud" },
  { id: "deepseek",    label: "DeepSeek",              baseURL: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat", keyHint: null,       kind: "cloud" },
  { id: "ollama",      label: "Ollama (local)",        baseURL: "http://localhost:11434/v1",   defaultModel: "llama3",      keyHint: "ollama",     kind: "local" },
  { id: "lmstudio",    label: "LM Studio (local)",     baseURL: "http://localhost:1234/v1",    defaultModel: null,          keyHint: "lm-studio",  kind: "local" },
  { id: "vllm",        label: "vLLM (local)",          baseURL: "http://localhost:8000/v1",    defaultModel: null,          keyHint: "vllm",       kind: "local" },
  { id: "custom",      label: "Custom OpenAI-compatible", baseURL: null,                       defaultModel: null,          keyHint: null,         kind: "custom" },
  { id: "passthrough", label: "Passthrough to Anthropic", baseURL: null,                        defaultModel: null,          keyHint: null,         kind: "passthrough" },
];

export interface SetupConfig {
  useOpenAI: boolean;
  openAIKey: string | null;
  openAIModel: string | null;
  openAIBaseURL: string | null;
  anthropicKey: string | null;
  port: number;
}

/** Serialize a SetupConfig to .env text. */
export function formatEnv(cfg: SetupConfig): string {
  const lines: string[] = [];
  lines.push(`# oscar config — written by src/setup.ts`);
  lines.push(`PROXY_PORT=${cfg.port}`);
  if (cfg.useOpenAI) {
    lines.push(`USE_OPENAI_API=1`);
    lines.push(`OPENAI_API_KEY=${cfg.openAIKey ?? ""}`);
    lines.push(`OPENAI_MODEL=${cfg.openAIModel ?? ""}`);
    lines.push(`OPENAI_BASE_URL=${cfg.openAIBaseURL ?? ""}`);
  }
  if (cfg.anthropicKey) {
    lines.push(`ANTHROPIC_API_KEY=${cfg.anthropicKey}`);
  }
  return lines.join("\n") + "\n";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/tsx/dist/cli.mjs --test test/setup.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/setup.ts test/setup.test.ts
git commit -m "feat: add setup wizard provider presets + formatEnv helper"
```

---

### Task 4: `probeModels` helper (`src/setup.ts`)

**Files:**
- Modify: `src/setup.ts` (add `probeModels`)
- Modify: `test/setup.test.ts` (add tests)

**Interfaces:**
- Produces:
  - `async function probeModels(baseURL: string, fetchImpl?: typeof fetch): Promise<string[]>` — GET `${baseURL}/models` with a 2s `AbortSignal.timeout`. Parses `{ data: [{ id: string }] }`. Returns `[]` on any error, timeout, or malformed response. The optional `fetchImpl` makes it testable without monkey-patching globals.

- [ ] **Step 1: Write the failing test**

Append to `test/setup.test.ts`:

```typescript
import { probeModels } from "../src/setup.ts";

test("probeModels: returns parsed model ids on happy path", async () => {
  const fakeFetch = (async (url: string | URL | Request, _init?: RequestInit) => {
    return new Response(JSON.stringify({ data: [{ id: "llama3" }, { id: "qwen2" }] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const ids = await probeModels("http://localhost:11434/v1", fakeFetch);
  assert.deepEqual(ids, ["llama3", "qwen2"]);
});

test("probeModels: returns [] on HTTP error status", async () => {
  const fakeFetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  const ids = await probeModels("http://localhost:11434/v1", fakeFetch);
  assert.deepEqual(ids, []);
});

test("probeModels: returns [] on malformed JSON", async () => {
  const fakeFetch = (async () => new Response("not json", { status: 200 })) as typeof fetch;
  const ids = await probeModels("http://localhost:11434/v1", fakeFetch);
  assert.deepEqual(ids, []);
});

test("probeModels: returns [] when fetch throws", async () => {
  const fakeFetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
  const ids = await probeModels("http://localhost:11434/v1", fakeFetch);
  assert.deepEqual(ids, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/tsx/dist/cli.mjs --test test/setup.test.ts`
Expected: FAIL — `probeModels is not a function` (not exported).

- [ ] **Step 3: Write minimal implementation**

Append to `src/setup.ts`:

```typescript
/** Probe an OpenAI-compatible /models endpoint. Returns [] on any failure/timeout. */
export async function probeModels(
  baseURL: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  try {
    const res = await fetchImpl(`${baseURL.replace(/\/$/, "")}/models`, {
      signal: AbortSignal.timeout(2000),
      headers: { "content-type": "application/json" },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    if (!Array.isArray(json.data)) return [];
    const ids: string[] = [];
    for (const m of json.data) if (typeof m?.id === "string") ids.push(m.id);
    return ids;
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/tsx/dist/cli.mjs --test test/setup.test.ts`
Expected: PASS — 7 tests (3 prior + 4 new).

- [ ] **Step 5: Commit**

```bash
git add src/setup.ts test/setup.test.ts
git commit -m "feat: add probeModels for local provider model discovery"
```

---

### Task 5: Interactive `main()` loop in `src/setup.ts`

**Files:**
- Modify: `src/setup.ts` (add `main()` + readline UI + `.env` write + optional proxy launch)
- No new tests — interactive UI is intentionally thin and not unit-tested (per spec).

**Interfaces:**
- Consumes: `PROVIDER_PRESETS`, `probeModels`, `formatEnv` (Tasks 3–4), `loadEnvFile` not needed here.
- Produces: a runnable `npx tsx src/setup.ts` that writes `.env` and optionally starts the proxy.

**Implementation notes:**
- Use `readline/promises` (`createInterface({ input: process.stdin, output: process.stdout })`).
- Provider selection: print a numbered list (1–7) and read a number; re-prompt on invalid. (Arrow-key TUI is nice-to-have but brittle across Windows terminals — a numbered list is robust and matches "guided setup" intent. Keep it simple.)
- Cloud provider: prompt for API key (required, non-empty → re-prompt); offer default model, allow override.
- Local provider: call `probeModels(preset.baseURL)`. If it returns models, show them numbered + a "type manually" option. If `[]`, prompt for manual model entry. Key = `preset.keyHint`.
- Custom: prompt for base URL, model, key.
- Passthrough: prompt for `ANTHROPIC_API_KEY` only.
- Port: default `8787`, prompt with default.
- Show a summary, ask "Write .env? (Y/n)". On yes, write `formatEnv(...)` to `.env` in cwd.
- Ask "Start the proxy now? (Y/n)". On yes, `spawn("npx", ["tsx", "src/server.ts"], { stdio: "inherit" })` and exit with the child's code.

- [ ] **Step 1: Implement `main()`**

Append to `src/setup.ts`:

```typescript
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

async function ask(rl: ReturnType<typeof createInterface>, q: string, fallback?: string): Promise<string> {
  const prompt = fallback !== undefined ? `${q} [${fallback}]: ` : `${q}: `;
  const answer = (await rl.question(prompt)).trim();
  return answer.length ? answer : (fallback ?? "");
}

async function askRequired(rl: ReturnType<typeof createInterface>, q: string): Promise<string> {
  for (;;) {
    const a = (await rl.question(`${q}: `)).trim();
    if (a) return a;
    console.log("  (required, try again)");
  }
}

function pickNumber(rl: ReturnType<typeof createInterface>, options: string[], prompt: string): Promise<number> {
  return (async () => {
    for (;;) {
      options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`));
      const a = (await rl.question(`${prompt}: `)).trim();
      const n = Number(a);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
      console.log("  (invalid choice, try again)");
    }
  })();
}

export async function main(): Promise<void> {
  const rl = createInterface({ input, output });
  console.log("\n=== oscar setup ===\n");

  const idx = await pickNumber(
    rl,
    PROVIDER_PRESETS.map((p) => p.label),
    "Choose an LLM provider",
  );
  const preset = PROVIDER_PRESETS[idx]!;

  const port = Number(await ask(rl, "Proxy port", "8787")) || 8787;

  let useOpenAI = false;
  let openAIKey: string | null = null;
  let openAIModel: string | null = null;
  let openAIBaseURL: string | null = null;
  let anthropicKey: string | null = null;

  if (preset.kind === "passthrough") {
    anthropicKey = await askRequired(rl, "Anthropic API key");
  } else {
    useOpenAI = true;
    openAIBaseURL = preset.baseURL
      ? await ask(rl, "Base URL", preset.baseURL)
      : await askRequired(rl, "Base URL (OpenAI-compatible)");

    // model selection
    if (preset.kind === "local") {
      const models = await probeModels(openAIBaseURL);
      if (models.length) {
        const choice = await pickNumber(rl, [...models, "Type manually"], "Pick a model");
        openAIModel = choice < models.length ? models[choice]! : await askRequired(rl, "Model name");
      } else {
        console.log(`  (could not reach ${openAIBaseURL}/models — enter the model name manually)`);
        openAIModel = preset.defaultModel
          ? await ask(rl, "Model name", preset.defaultModel)
          : await askRequired(rl, "Model name");
      }
    } else if (preset.defaultModel) {
      openAIModel = await ask(rl, "Model", preset.defaultModel);
    } else {
      openAIModel = await askRequired(rl, "Model name");
    }

    openAIKey = preset.keyHint
      ? (await ask(rl, "API key (local servers usually ignore this)", preset.keyHint) || preset.keyHint)
      : await askRequired(rl, "API key");
  }

  const cfg: SetupConfig = { useOpenAI, openAIKey, openAIModel, openAIBaseURL, anthropicKey, port };

  console.log("\n--- summary ---");
  console.log(`  provider: ${preset.label}`);
  if (useOpenAI) {
    console.log(`  base URL: ${openAIBaseURL}`);
    console.log(`  model:    ${openAIModel}`);
    console.log(`  key:      ${openAIKey ? openAIKey.slice(0, 4) + "..." : "(none)"}`);
  } else {
    console.log(`  anthropic key: ${anthropicKey ? anthropicKey.slice(0, 4) + "..." : "(none)"}`);
  }
  console.log(`  port: ${port}\n`);

  const write = (await ask(rl, "Write .env?", "Y")).toLowerCase();
  if (write.startsWith("y") || write === "") {
    const envPath = resolve(".env");
    writeFileSync(envPath, formatEnv(cfg));
    console.log(`  wrote ${envPath}`);
  } else {
    console.log("  skipped writing .env — exiting without changes.");
    rl.close();
    return;
  }

  const start = (await ask(rl, "Start the proxy now?", "Y")).toLowerCase();
  rl.close();
  if (start.startsWith("y") || start === "") {
    const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", "src/server.ts"], {
      stdio: "inherit",
    });
    child.on("close", (code) => process.exit(code ?? 0));
  } else {
    console.log("\nDone. Run with: npx tsx src/server.ts  (or bash scripts/run.sh)");
  }
}

// Run only when invoked directly.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `node node_modules/typescript/bin/tsc --noEmit`
Expected: EXIT 0 — no type errors.

If the `import.meta.url` guard complains under strict mode, replace the guard with:
```typescript
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve("src/setup.ts");
if (isMain) { main().catch(...); }
```
and re-run tsc.

- [ ] **Step 3: Manual smoke test (interactive — cannot be automated)**

Run: `echo -e "1\n\nsk-test\n\nY\nn\n" | npx tsx src/setup.ts`
Expected: writes `.env` containing `USE_OPENAI_API=1`, `OPENAI_API_KEY=sk-test`, `OPENAI_MODEL=gpt-4o-mini`, `OPENAI_BASE_URL=https://api.openai.com/v1`, `PROXY_PORT=8787`; does not start the proxy (answered `n`).

Verify the file:
Run: `node -e "console.log(require('fs').readFileSync('.env','utf8'))"`
Expected: the 6 lines above.

Clean up: `rm .env`

- [ ] **Step 4: Run full test suite to confirm no regressions**

Run: `node node_modules/tsx/dist/cli.mjs --test test/cases.test.ts test/setup.test.ts test/envfile.test.ts test/env-loading.test.ts`
Expected: PASS — 15 + 7 + 4 + 2 = 28 tests.

- [ ] **Step 5: Commit**

```bash
git add src/setup.ts
git commit -m "feat: add interactive setup wizard (src/setup.ts main loop)"
```

---

### Task 6: Wire wizard into `scripts/run.sh`

**Files:**
- Modify: `scripts/run.sh`

- [ ] **Step 1: Edit `scripts/run.sh`**

Insert a setup-invocation block immediately after the `PORT=...` line (line 7) and before the `CLI_BIN` lookup. The block:

```bash
# Run the interactive setup wizard on first run or when --setup is passed.
SETUP_FLAG=0
for arg in "$@"; do [ "$arg" = "--setup" ] && SETUP_FLAG=1; done
if [ ! -f "$ROOT/.env" ] || [ "$SETUP_FLAG" = "1" ]; then
  echo "Running setup wizard ..."
  npx tsx "$ROOT/src/setup.ts" || true
  # If the wizard already started the proxy, .env exists but we still continue
  # to launch the CLI below against the (possibly already-running) proxy.
fi
```

Leave the rest of `run.sh` unchanged.

- [ ] **Step 2: Syntax check**

Run: `bash -n scripts/run.sh`
Expected: SYNTAX OK (no output, exit 0).

- [ ] **Step 3: Manual smoke test**

Run: `rm -f .env && echo -e "7\nsk-ant-test\nY\nn\n" | bash scripts/run.sh`
Expected: wizard runs, writes `.env` with `ANTHROPIC_API_KEY=sk-ant-test`, then `run.sh` proceeds to launch the CLI (or errors that the CLI isn't on PATH — either way the wizard ran). Stop the process.

Clean up: `rm -f .env`

- [ ] **Step 4: Commit**

```bash
git add scripts/run.sh
git commit -m "feat: run setup wizard from run.sh on first run / --setup"
```

---

### Task 7: `package.json` script + `.gitignore` `.env`

**Files:**
- Modify: `package.json` (add `"setup"` to scripts)
- Modify: `.gitignore` (add `.env`)

- [ ] **Step 1: Edit `package.json`**

Add to the `"scripts"` object:

```json
"setup": "tsx src/setup.ts"
```

So scripts becomes:
```json
"scripts": {
  "start": "tsx src/server.ts",
  "dev": "node --watch --import tsx src/server.ts",
  "setup": "tsx src/setup.ts",
  "test": "tsx --test test/*.test.ts",
  "typecheck": "tsc --noEmit"
}
```

- [ ] **Step 2: Edit `.gitignore`**

Add after the `# Node` section:

```gitignore
# Local config written by the setup wizard
.env
```

- [ ] **Step 3: Verify**

Run: `node -e "console.log(Object.keys(require('./package.json').scripts).sort())"`
Expected: `[ 'dev', 'setup', 'start', 'test', 'typecheck' ]`

Run: `grep -c '^\.env$' .gitignore`
Expected: `1`

- [ ] **Step 4: Commit**

```bash
git add package.json .gitignore
git commit -m "chore: add setup script and ignore .env"
```

---

### Task 8: Update SKILL.md / README to mention the wizard

**Files:**
- Modify: `skills/oscar/SKILL.md`
- Modify: `README.md`

- [ ] **Step 1: Edit `skills/oscar/SKILL.md`**

Replace the "## Setup" section with:

```markdown
## Setup

Run the interactive setup wizard — it asks which LLM provider to use (OpenAI,
DeepSeek, Ollama, LM Studio, vLLM, custom, or Anthropic passthrough), collects
your key/model, writes a `.env`, and offers to start the proxy:

```bash
npm run setup
```

Or equivalently:

```bash
npx tsx src/setup.ts
```

If `.env` is missing, `bash scripts/run.sh` runs the wizard automatically before
launching the CLI.

Then install Node deps and the CLI (one-time):

```bash
npm install
bash scripts/install-sdk.sh
```
```

- [ ] **Step 2: Edit `README.md`**

In the "Run" / setup area, add a short "Quick start" block describing `npm run setup` as the recommended first step, mirroring the SKILL.md text.

- [ ] **Step 3: Verify no stray Bun references and files are well-formed**

Run: `grep -rn "bun" README.md skills/oscar/SKILL.md`
Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add skills/oscar/SKILL.md README.md
git commit -m "docs: document the interactive setup wizard"
```

---

### Task 9: Final verification

- [ ] **Step 1: Typecheck**

Run: `node node_modules/typescript/bin/tsc --noEmit`
Expected: EXIT 0.

- [ ] **Step 2: Full test suite**

Run: `node node_modules/tsx/dist/cli.mjs --test test/*.test.ts`
Expected: PASS — all tests (15 cases + 7 setup + 4 envfile + 2 env-loading + 4 integration = 32).

- [ ] **Step 3: install-sdk.sh still valid (untouched, sanity)**

Run: `bash -n scripts/install-sdk.sh`
Expected: exit 0.

- [ ] **Step 4: run.sh still valid**

Run: `bash -n scripts/run.sh`
Expected: exit 0.

- [ ] **Step 5: Wizard binary exists and starts**

Run: `echo -e "1\n\nsk-test\n\nY\nn\n" | npx tsx src/setup.ts`
Expected: writes `.env`, exits 0 without starting the proxy.
Clean up: `rm -f .env`

No commit (verification only).