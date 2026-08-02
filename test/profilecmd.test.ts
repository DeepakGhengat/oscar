// `oscar --profiles` and `oscar --use <name>`. Exit codes matter here: these
// are the commands people put in scripts, so "profile not found" must not
// look like success.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/profilecmd.ts";
import { profilesDir } from "../src/profiles.ts";

let dir: string;
let prevConfig: string | undefined;
let out: string[];
let err: string[];
const realLog = console.log;
const realError = console.error;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oscar-profilecmd-"));
  prevConfig = process.env.OSCAR_CONFIG;
  process.env.OSCAR_CONFIG = dir;
  out = [];
  err = [];
  console.log = (...a: unknown[]) => out.push(a.join(" "));
  console.error = (...a: unknown[]) => err.push(a.join(" "));
});

afterEach(() => {
  console.log = realLog;
  console.error = realError;
  if (prevConfig === undefined) delete process.env.OSCAR_CONFIG;
  else process.env.OSCAR_CONFIG = prevConfig;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* cosmetic */
  }
});

const plain = (s: string[]) => s.join("\n").replace(/\[[0-9;]*m/g, "");

function addProfile(name: string, body: string): void {
  const d = profilesDir(dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${name}.env`), body);
}

/* --------------------------------- listing -------------------------------- */

test("an empty profile store says so and still succeeds", () => {
  assert.equal(main([]), 0, "listing nothing is not an error");
  assert.match(plain(out), /None saved yet/);
});

test("saved profiles are listed with a summary", () => {
  addProfile("local", "USE_OPENAI_API=1\nOPENAI_BASE_URL=http://localhost:11434/v1\nOPENAI_MODEL=qwen2.5:7b\n");
  addProfile("cloud", "USE_OPENAI_API=1\nOPENAI_BASE_URL=https://api.deepseek.com/v1\nOPENAI_MODEL=deepseek-chat\n");
  assert.equal(main([]), 0);
  const text = plain(out);
  assert.match(text, /local/);
  assert.match(text, /cloud/);
  assert.match(text, /qwen2\.5:7b/);
});

test("the listing tells you how to switch", () => {
  addProfile("local", "USE_OPENAI_API=1\nOPENAI_MODEL=m\n");
  main([]);
  assert.match(plain(out), /oscar --use/);
});

/* -------------------------------- switching ------------------------------- */

test("--use activates a profile and writes the config", () => {
  addProfile("local", "USE_OPENAI_API=1\nOPENAI_MODEL=qwen2.5:7b\n");
  assert.equal(main(["--use", "local"]), 0);
  const written = readFileSync(join(dir, ".env"), "utf8");
  assert.match(written, /OPENAI_MODEL=qwen2\.5:7b/);
});

test("--use reports the active profile back", () => {
  addProfile("local", "USE_OPENAI_API=1\nOPENAI_MODEL=m\n");
  main(["--use", "local"]);
  assert.match(plain(out), /switched to/);
});

test("the active profile is marked in the listing", () => {
  addProfile("local", "USE_OPENAI_API=1\nOPENAI_MODEL=m\n");
  addProfile("other", "USE_OPENAI_API=1\nOPENAI_MODEL=n\n");
  main(["--use", "local"]);
  out = [];
  main([]);
  const active = plain(out).split("\n").find((l) => l.includes("●"));
  assert.ok(active, "one profile should be marked active");
  assert.match(active, /local/);
});

/* --------------------------------- failure -------------------------------- */

test("an unknown profile fails with a non-zero exit code", () => {
  addProfile("local", "USE_OPENAI_API=1\n");
  // Returning 0 here would let a scripted `oscar --use typo && oscar` run on
  // the wrong config silently.
  assert.equal(main(["--use", "does-not-exist"]), 1);
  assert.match(plain(err), /does-not-exist|not found|no such/i);
});

test("--use with no name fails and shows what is available", () => {
  addProfile("local", "USE_OPENAI_API=1\n");
  assert.equal(main(["--use"]), 1);
  assert.match(plain(err), /Usage/);
  assert.match(plain(out), /local/, "the list should be shown as a hint");
});

test("--use followed by another flag is treated as a missing name", () => {
  assert.equal(main(["--use", "--profiles"]), 1);
});

test("a failed switch leaves the existing config untouched", () => {
  addProfile("good", "USE_OPENAI_API=1\nOPENAI_MODEL=keep-me\n");
  main(["--use", "good"]);
  const before = readFileSync(join(dir, ".env"), "utf8");
  assert.equal(main(["--use", "nope"]), 1);
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), before, "a bad switch must not clobber the config");
});
