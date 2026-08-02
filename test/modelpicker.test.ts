// rewriteKey / envFilePath — the bits of --model and --switch that touch the
// user's .env. A bug here silently corrupts their config, so cover the
// surgical-edit guarantees explicitly.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envFilePath, rewriteKey } from "../src/modelpicker.ts";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccf-picker-"));
  file = join(dir, ".env");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/* -------------------------------- rewriteKey ------------------------------ */

test("rewriteKey replaces an existing value in place", () => {
  writeFileSync(file, "PROXY_PORT=8787\nOPENAI_MODEL=old-model\nUSE_OPENAI_API=1\n");
  rewriteKey(file, "OPENAI_MODEL", "glm-5.2:cloud");
  assert.equal(
    readFileSync(file, "utf8"),
    "PROXY_PORT=8787\nOPENAI_MODEL=glm-5.2:cloud\nUSE_OPENAI_API=1\n",
  );
});

test("rewriteKey appends when the key is absent", () => {
  writeFileSync(file, "PROXY_PORT=8787\n");
  rewriteKey(file, "OPENAI_MODEL", "qwen2.5:7b");
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.deepEqual(lines, ["PROXY_PORT=8787", "OPENAI_MODEL=qwen2.5:7b"]);
});

test("rewriteKey creates the file when it doesn't exist yet", () => {
  rewriteKey(file, "OPENAI_MODEL", "m");
  assert.equal(readFileSync(file, "utf8"), "OPENAI_MODEL=m\n");
});

test("rewriteKey leaves comments and unrelated keys untouched", () => {
  writeFileSync(
    file,
    "# claude-code-free config\nPROXY_PORT=8787\n\n# backend\nOPENAI_MODEL=old\nOPENAI_API_KEY=sk-secret\n",
  );
  rewriteKey(file, "OPENAI_MODEL", "new");
  const out = readFileSync(file, "utf8");
  assert.match(out, /^# claude-code-free config$/m);
  assert.match(out, /^# backend$/m);
  assert.match(out, /^OPENAI_API_KEY=sk-secret$/m, "unrelated secrets must survive");
  assert.match(out, /^OPENAI_MODEL=new$/m);
});

test("rewriteKey ignores a commented-out line with the same key", () => {
  // `#OPENAI_MODEL=x` is not a definition — appending is correct, editing is not.
  writeFileSync(file, "#OPENAI_MODEL=commented\nPROXY_PORT=1\n");
  rewriteKey(file, "OPENAI_MODEL", "real");
  const out = readFileSync(file, "utf8");
  assert.match(out, /^#OPENAI_MODEL=commented$/m, "the comment must stay a comment");
  assert.match(out, /^OPENAI_MODEL=real$/m);
});

test("rewriteKey does not match a key that merely shares a prefix", () => {
  writeFileSync(file, "OPENAI_MODEL_FALLBACK=keep-me\nPROXY_PORT=1\n");
  rewriteKey(file, "OPENAI_MODEL", "new");
  const out = readFileSync(file, "utf8");
  assert.match(out, /^OPENAI_MODEL_FALLBACK=keep-me$/m);
  assert.match(out, /^OPENAI_MODEL=new$/m);
});

test("rewriteKey tolerates whitespace around the key", () => {
  writeFileSync(file, "  OPENAI_MODEL = old \n");
  rewriteKey(file, "OPENAI_MODEL", "new");
  assert.match(readFileSync(file, "utf8"), /^OPENAI_MODEL=new$/m);
});

test("rewriteKey handles values containing '=' and ':'", () => {
  rewriteKey(file, "OPENAI_BASE_URL", "http://localhost:11434/v1?a=b");
  rewriteKey(file, "OPENAI_MODEL", "owner/model:latest");
  const out = readFileSync(file, "utf8");
  assert.match(out, /^OPENAI_BASE_URL=http:\/\/localhost:11434\/v1\?a=b$/m);
  assert.match(out, /^OPENAI_MODEL=owner\/model:latest$/m);
});

test("rewriteKey ends the file with exactly one newline", () => {
  writeFileSync(file, "PROXY_PORT=1\n\n\n");
  rewriteKey(file, "OPENAI_MODEL", "m");
  const out = readFileSync(file, "utf8");
  assert.ok(out.endsWith("\n"));
  assert.ok(!out.endsWith("\n\n"), "repeated rewrites must not grow trailing blank lines");
});

test("repeated rewrites converge instead of accumulating lines", () => {
  writeFileSync(file, "OPENAI_MODEL=a\n");
  for (const m of ["b", "c", "d"]) rewriteKey(file, "OPENAI_MODEL", m);
  const modelLines = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("OPENAI_MODEL="));
  assert.deepEqual(modelLines, ["OPENAI_MODEL=d"]);
});

/* ------------------------------- envFilePath ------------------------------ */

test("envFilePath resolves CLAUDE_CODE_FREE_CONFIG as a directory", () => {
  // Regression: it was once treated as a file path, so the global install
  // wrote its config to the wrong place.
  const prev = process.env.CLAUDE_CODE_FREE_CONFIG;
  process.env.CLAUDE_CODE_FREE_CONFIG = dir;
  try {
    assert.equal(envFilePath(), join(dir, ".env"));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_FREE_CONFIG;
    else process.env.CLAUDE_CODE_FREE_CONFIG = prev;
  }
});

test("envFilePath falls back to .env in the cwd for local dev", () => {
  const prev = process.env.CLAUDE_CODE_FREE_CONFIG;
  delete process.env.CLAUDE_CODE_FREE_CONFIG;
  try {
    assert.match(envFilePath(), /[\\/]\.env$/);
  } finally {
    if (prev !== undefined) process.env.CLAUDE_CODE_FREE_CONFIG = prev;
  }
});
