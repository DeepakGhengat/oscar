// User-facing branding: the launch banner, and the throwaway Claude Code
// profile O.S.C.A.R. seeds so the session opens with our status line instead
// of a first-run theme picker.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { banner, seedClaudeProfile } from "../bin/oscar.mjs";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "oscar-brand-"));
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* cosmetic */
  }
}

const strip = (s: string) => s.replace(/\[[0-9;]*m/g, "");

/* --------------------------------- banner --------------------------------- */

test("the banner carries the product name and expansion", () => {
  const out = strip(banner([]));
  assert.match(out, /Orchestrator for System Coding & Autonomous Routing/);
});

test("the banner includes the caller's detail lines", () => {
  const out = strip(banner(["routing   qwen2.5:7b", "proxy     http://localhost:8787"]));
  assert.match(out, /routing {3}qwen2\.5:7b/);
	assert.match(out, /proxy {5}http:\/\/localhost:8787/);
});

test("the banner renders with no detail lines at all", () => {
  assert.ok(strip(banner([])).length > 0);
});

/* ---------------------------- profile seeding ----------------------------- */

test("seeding suppresses the first-run theme picker", () => {
  // A throwaway profile means Claude Code runs onboarding on *every* launch.
  const dir = tmp();
  try {
    seedClaudeProfile(dir, "node statusline.mjs");
    const claudeJson = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"));
    assert.equal(claudeJson.hasCompletedOnboarding, true);
    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    assert.equal(settings.theme, "dark");
  } finally {
    cleanup(dir);
  }
});

test("seeding installs the O.S.C.A.R. status line", () => {
  const dir = tmp();
  try {
    seedClaudeProfile(dir, "node /path/to/oscar-statusline.mjs");
    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    assert.deepEqual(settings.statusLine, {
      type: "command",
      command: "node /path/to/oscar-statusline.mjs",
    });
  } finally {
    cleanup(dir);
  }
});

test("seeding never overwrites choices the user already made", () => {
  const dir = tmp();
  try {
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ theme: "light", statusLine: { type: "command", command: "mine" } }),
    );
    seedClaudeProfile(dir, "node ours.mjs");
    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    assert.equal(settings.theme, "light", "a chosen theme must survive");
    assert.equal(settings.statusLine.command, "mine", "a custom status line must survive");
  } finally {
    cleanup(dir);
  }
});

test("seeding preserves unrelated settings", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ permissions: { allow: ["Bash"] } }));
    seedClaudeProfile(dir, "node ours.mjs");
    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    assert.deepEqual(settings.permissions, { allow: ["Bash"] });
    assert.equal(settings.theme, "dark");
  } finally {
    cleanup(dir);
  }
});

test("a corrupt settings file is replaced rather than crashing the launch", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "settings.json"), "{ not json");
    assert.doesNotThrow(() => seedClaudeProfile(dir, "node ours.mjs"));
    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    assert.equal(settings.theme, "dark");
  } finally {
    cleanup(dir);
  }
});

test("seeding is idempotent", () => {
  const dir = tmp();
  try {
    seedClaudeProfile(dir, "node ours.mjs");
    const first = readFileSync(join(dir, "settings.json"), "utf8");
    seedClaudeProfile(dir, "node ours.mjs");
    assert.equal(readFileSync(join(dir, "settings.json"), "utf8"), first);
  } finally {
    cleanup(dir);
  }
});

test("seeding without a status line command still fixes onboarding", () => {
  const dir = tmp();
  try {
    seedClaudeProfile(dir);
    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    assert.equal(settings.theme, "dark");
    assert.equal(settings.statusLine, undefined);
    const claudeJson = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"));
    assert.equal(claudeJson.hasCompletedOnboarding, true);
  } finally {
    cleanup(dir);
  }
});
