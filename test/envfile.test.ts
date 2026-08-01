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