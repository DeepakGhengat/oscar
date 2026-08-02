// Pure helpers inside bin/oscar.mjs. Importing the launcher must
// not start a proxy or spawn the CLI — the CLI entry point is guarded, and the
// first test here is what proves that guard works.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareVersions,
  isCliEntry,
  newestVersioned,
  parseEnvFile,
} from "../bin/oscar.mjs";

/* ------------------------------- parseEnvFile ----------------------------- */

test("parseEnvFile reads plain KEY=VALUE lines", () => {
  assert.deepEqual(parseEnvFile("A=1\nB=two\n"), { A: "1", B: "two" });
});

test("parseEnvFile skips blanks and comments", () => {
  assert.deepEqual(parseEnvFile("\n# comment\nA=1\n\n   \n# another\nB=2\n"), { A: "1", B: "2" });
});

test("parseEnvFile strips matching surrounding quotes", () => {
  assert.deepEqual(parseEnvFile(`A="quoted"\nB='single'\n`), { A: "quoted", B: "single" });
});

test("parseEnvFile leaves mismatched quotes alone", () => {
  assert.deepEqual(parseEnvFile(`A="unbalanced\n`), { A: '"unbalanced' });
});

test("parseEnvFile keeps '=' inside values", () => {
  // Base URLs carry query strings; API keys can contain padding.
  assert.deepEqual(parseEnvFile("URL=http://h/v1?a=b&c=d\nK=abc==\n"), {
    URL: "http://h/v1?a=b&c=d",
    K: "abc==",
  });
});

test("parseEnvFile handles CRLF files", () => {
  assert.deepEqual(parseEnvFile("A=1\r\nB=2\r\n"), { A: "1", B: "2" });
});

test("parseEnvFile ignores lines without '=' and empty keys", () => {
  assert.deepEqual(parseEnvFile("garbage\n=novalue\nA=1\n"), { A: "1" });
});

test("parseEnvFile on empty input yields an empty object", () => {
  assert.deepEqual(parseEnvFile(""), {});
});

/* ------------------------------ compareVersions --------------------------- */

test("compareVersions orders numerically, not lexically", () => {
  // The bug this guards: "2.1.99" sorts after "2.1.219" as a string.
  assert.ok(compareVersions("2.1.219", "2.1.99") > 0);
  assert.ok(compareVersions("2.1.99", "2.1.219") < 0);
  assert.equal(compareVersions("2.1.219", "2.1.219"), 0);
});

test("compareVersions spans major and minor components", () => {
  assert.ok(compareVersions("3.0.0", "2.9.9") > 0);
  assert.ok(compareVersions("2.2.0", "2.1.999") > 0);
});

test("compareVersions treats missing components as zero", () => {
  assert.equal(compareVersions("2.1", "2.1.0"), 0);
  assert.ok(compareVersions("2.1.1", "2.1") > 0);
});

/* ----------------------------- newestVersioned ---------------------------- */

function makeInstall(versions: string[], exe: string, opts: { skipExe?: string[] } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "oscar-install-"));
  for (const v of versions) {
    mkdirSync(join(root, v), { recursive: true });
    if (!opts.skipExe?.includes(v)) writeFileSync(join(root, v, exe), "");
  }
  return root;
}

test("newestVersioned picks the highest version present", () => {
  const root = makeInstall(["2.1.99", "2.1.219", "2.0.5"], "claude.exe");
  try {
    const found = newestVersioned(root, "claude.exe");
    assert.equal(found?.version, "2.1.219");
    assert.equal(found?.path, join(root, "2.1.219", "claude.exe"));
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("newestVersioned skips versions whose binary is missing", () => {
  // A half-removed upgrade leaves the directory behind; picking it would make
  // the launcher spawn a path that doesn't exist.
  const root = makeInstall(["2.1.219", "2.1.100"], "claude.exe", { skipExe: ["2.1.219"] });
  try {
    assert.equal(newestVersioned(root, "claude.exe")?.version, "2.1.100");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("newestVersioned ignores non-version directories", () => {
  const root = makeInstall(["2.1.5", "current", "backup"], "claude.exe");
  try {
    assert.equal(newestVersioned(root, "claude.exe")?.version, "2.1.5");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

/* ------------------------------- CLI entry -------------------------------- */

test("isCliEntry is true when the file is run directly", () => {
  const self = fileURLToPath(new URL("../bin/oscar.mjs", import.meta.url));
  assert.equal(isCliEntry(self, self), true);
});

test("isCliEntry sees through a symlinked global install", () => {
  // Regression: `npm link`/`npm i -g` puts the package in npm's node_modules
  // as a symlink, so argv[1] is the linked path while import.meta.url is the
  // real one. Comparing them literally made the global `oscar`
  // command exit 0 having done nothing at all.
  const real = fileURLToPath(new URL("../bin/oscar.mjs", import.meta.url));
  const linkRoot = mkdtempSync(join(tmpdir(), "oscar-link-"));
  const link = join(linkRoot, "pkg");
  try {
    symlinkSync(join(real, "..", ".."), link, "junction");
  } catch {
    // Creating links can need privileges; skip rather than fail the suite.
    rmSync(linkRoot, { recursive: true, force: true });
    return;
  }
  try {
    const viaLink = join(link, "bin", "oscar.mjs");
    assert.notEqual(viaLink, real, "the test needs the two paths to differ");
    assert.equal(isCliEntry(viaLink, real), true, "the global command would do nothing");
  } finally {
    rmSync(linkRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("isCliEntry is false when imported", () => {
  const self = fileURLToPath(new URL("../bin/oscar.mjs", import.meta.url));
  // argv[1] is the test runner, not the launcher.
  assert.equal(isCliEntry(process.argv[1], self), false);
  assert.equal(isCliEntry(undefined, self), false);
});

test("newestVersioned returns null for a missing or empty root", () => {
  assert.equal(newestVersioned(join(tmpdir(), "oscar-does-not-exist-xyz"), "claude.exe"), null);
  const empty = mkdtempSync(join(tmpdir(), "oscar-empty-"));
  try {
    assert.equal(newestVersioned(empty, "claude.exe"), null);
  } finally {
    rmSync(empty, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
