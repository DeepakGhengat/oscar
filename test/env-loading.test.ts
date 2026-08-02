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
  // Windows can hold a transient handle on the directory we just chdir'd out
  // of, so rmSync intermittently throws EPERM. Retry, and treat a leftover
  // temp dir as cosmetic rather than failing the run.
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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