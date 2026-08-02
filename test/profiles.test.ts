// Saved configurations.
//
// `oscar --setup` rewrites the whole .env. Reported: after a working Ollama
// Cloud setup, choosing "Anthropic account sign-in" from the wizard silently
// discarded the base URL, key and model — and the next `oscar --model` said
// "No OPENAI_BASE_URL". Nothing was recoverable except by retyping it.
//
// Setup now saves every config it writes, and `oscar --use <name>` switches
// between them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateProfile,
  describeProfile,
  listProfiles,
  parseEnvText,
  profilePath,
  sanitizeProfileName,
  saveProfile,
} from "../src/profiles.ts";
import { profileNameFor } from "../src/setup.ts";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "oscar-profiles-"));
}

const OLLAMA = [
  "PROXY_PORT=8787",
  "USE_OPENAI_API=1",
  "OPENAI_API_KEY=sk-abc",
  "OPENAI_MODEL=glm-5.2:cloud",
  "OPENAI_BASE_URL=https://ollama.com/v1",
].join("\n") + "\n";

const SUBSCRIPTION = "# oscar config\nOSCAR_AUTH=subscription\n";
const API_KEY = "PROXY_PORT=8787\nANTHROPIC_API_KEY=sk-ant-xyz\n";

/* -------------------------------- naming ---------------------------------- */

test("profile names are reduced to safe filenames", () => {
  assert.equal(sanitizeProfileName("Ollama Cloud"), "ollama-cloud");
  assert.equal(sanitizeProfileName("  MiXeD  "), "mixed");
  assert.equal(sanitizeProfileName("../../etc/passwd"), "etc-passwd");
  assert.equal(sanitizeProfileName("a".repeat(80)).length, 40);
});

test("a name that sanitizes to nothing is refused rather than guessed at", () => {
  assert.equal(sanitizeProfileName("///"), "");
  assert.equal(saveProfile("///", "x", dir()), null);
});

/* ------------------------------ description ------------------------------- */

test("a config is described by what it does, not by which preset made it", () => {
  assert.equal(describeProfile(OLLAMA), "glm-5.2:cloud via ollama.com/v1");
  assert.equal(describeProfile(SUBSCRIPTION), "Anthropic account sign-in (the CLI's own login)");
  assert.equal(describeProfile(API_KEY), "Anthropic API key (passthrough)");
});

test("an incomplete config still describes itself without throwing", () => {
  assert.match(describeProfile("USE_OPENAI_API=1\n"), /no model/);
  assert.equal(describeProfile(""), "Anthropic account sign-in (no key stored)");
});

test("parseEnvText ignores comments and strips quotes", () => {
  const env = parseEnvText('# note\nA=1\nB="two"\nC=\'three\'\nnonsense\n');
  assert.deepEqual(env, { A: "1", B: "two", C: "three" });
});

/* ------------------------------ save + list ------------------------------- */

test("saving writes under profiles/ and listing finds it", () => {
  const d = dir();
  const path = saveProfile("ollama", OLLAMA, d);
  assert.ok(path && existsSync(path));
  const list = listProfiles(d);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.name, "ollama");
  assert.equal(list[0]!.summary, "glm-5.2:cloud via ollama.com/v1");
});

test("the profile matching the active .env is marked, the others are not", () => {
  const d = dir();
  saveProfile("ollama", OLLAMA, d);
  saveProfile("subscription", SUBSCRIPTION, d);
  writeFileSync(join(d, ".env"), SUBSCRIPTION);
  const byName = Object.fromEntries(listProfiles(d).map((p) => [p.name, p]));
  assert.equal(byName.subscription!.active, true);
  assert.equal(byName.ollama!.active, false);
});

test("listing an empty or missing profiles directory returns nothing", () => {
  assert.deepEqual(listProfiles(dir()), []);
});

test("non-.env files in the directory are ignored", () => {
  const d = dir();
  saveProfile("ollama", OLLAMA, d);
  writeFileSync(join(d, "profiles", "README.md"), "not a profile");
  assert.deepEqual(listProfiles(d).map((p) => p.name), ["ollama"]);
});

/* ------------------------------- activation ------------------------------- */

test("regression: the reported flow no longer loses the Ollama config", () => {
  const d = dir();
  // 1. Ollama is set up and becomes active.
  saveProfile("ollama", OLLAMA, d);
  writeFileSync(join(d, ".env"), OLLAMA);
  // 2. Setup is run again for account sign-in, replacing .env.
  saveProfile("subscription", SUBSCRIPTION, d);
  writeFileSync(join(d, ".env"), SUBSCRIPTION);
  // 3. Going back is one command, not a re-run of the wizard.
  const result = activateProfile("ollama", d);
  assert.equal(result.ok, true);
  assert.equal(readFileSync(join(d, ".env"), "utf8"), OLLAMA);
  assert.match(result.summary!, /glm-5\.2:cloud/);
});

test("switching back and forth is stable", () => {
  const d = dir();
  saveProfile("a", OLLAMA, d);
  saveProfile("b", SUBSCRIPTION, d);
  for (const [name, want] of [["a", OLLAMA], ["b", SUBSCRIPTION], ["a", OLLAMA]] as const) {
    assert.equal(activateProfile(name, d).ok, true);
    assert.equal(readFileSync(join(d, ".env"), "utf8"), want);
  }
});

test("an unsaved active config is preserved before being replaced", () => {
  const d = dir();
  saveProfile("subscription", SUBSCRIPTION, d);
  // An .env that matches no saved profile — hand-edited, say.
  const handEdited = OLLAMA.replace("glm-5.2:cloud", "hand-edited-model");
  writeFileSync(join(d, ".env"), handEdited);
  activateProfile("subscription", d);
  const previous = listProfiles(d).find((p) => p.name === "previous");
  assert.ok(previous, "the replaced config must be recoverable");
  assert.equal(readFileSync(previous!.path, "utf8"), handEdited);
});

test("an unknown name lists what is actually available", () => {
  const d = dir();
  saveProfile("ollama", OLLAMA, d);
  const r = activateProfile("nope", d);
  assert.equal(r.ok, false);
  assert.match(r.error!, /no profile named "nope"/);
  assert.match(r.error!, /ollama/);
});

test("an unknown name with nothing saved points at setup", () => {
  const r = activateProfile("nope", dir());
  assert.equal(r.ok, false);
  assert.match(r.error!, /oscar --setup/);
});

test("a name that cannot be a filename is refused", () => {
  const r = activateProfile("///", dir());
  assert.equal(r.ok, false);
  assert.match(r.error!, /not a usable profile name/);
});

test("profilePath sanitizes, so a traversal cannot escape the directory", () => {
  const d = dir();
  const p = profilePath("../../escape", d);
  assert.ok(p.startsWith(join(d, "profiles")), p);
});

/* --------------------- naming a config being replaced --------------------- */

test("a replaced config is named after what it is", () => {
  assert.equal(profileNameFor(OLLAMA), "ollama");
  assert.equal(profileNameFor(SUBSCRIPTION), "subscription");
  assert.equal(profileNameFor(API_KEY), "passthrough");
  assert.equal(
    profileNameFor("USE_OPENAI_API=1\nOPENAI_BASE_URL=http://localhost:11434/v1\n"),
    "local",
  );
  assert.equal(
    profileNameFor("USE_OPENAI_API=1\nOPENAI_BASE_URL=https://api.deepseek.com/v1\n"),
    "deepseek",
  );
});

test("an unrecognised host still yields a usable name", () => {
  const name = profileNameFor("USE_OPENAI_API=1\nOPENAI_BASE_URL=https://llm.example.com/v1\n");
  assert.equal(sanitizeProfileName(name), name, "must already be filename-safe");
  assert.ok(name.length > 0);
});

/* ------------------------------- robustness ------------------------------- */

test("an unreadable profile entry is skipped, not fatal", () => {
  const d = dir();
  saveProfile("good", OLLAMA, d);
  mkdirSync(join(d, "profiles", "broken.env"), { recursive: true }); // a directory
  assert.deepEqual(listProfiles(d).map((p) => p.name), ["good"]);
});
