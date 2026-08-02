// The CLI will not use ANTHROPIC_API_KEY unless the key is pre-approved in
// the profile it is running against.
//
// From the CLI's own resolver (v2.1.220):
//
//     function i7()  { return !isInteractive; }
//     function XT1() { return i7() && clientType !== "claude-vscode"; }
//     function Dv(A) { return A.slice(-20); }
//
//     if (XT1() && key) return { key, source: "ANTHROPIC_API_KEY" };   // -p mode
//     ...
//     if (key && config.customApiKeyResponses?.approved?.includes(Dv(key)))
//       return { key, source: "ANTHROPIC_API_KEY" };                   // interactive
//
// Non-interactive runs take the key outright. An interactive session requires
// the approval, and without it falls through to the OAuth login — which a
// throwaway profile does not have. The result is a session that opens on
// "Not logged in · Run /login" while the proxy sits there correctly
// configured, with the backend models already listed.
//
// These tests replicate that predicate exactly. If the CLI ever changes the
// id form or the field names, they are what should fail.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiKeyId, approveApiKey } from "../bin/oscar.mjs";

const DUMMY = "oscar-dummy-key";

function profile(): string {
  return mkdtempSync(join(tmpdir(), "oscar-approval-"));
}
function readState(dir: string): any {
  return JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"));
}
/** The CLI's own acceptance check, transcribed. */
function cliWouldUseKey(state: any, key: string): boolean {
  return Boolean(state?.customApiKeyResponses?.approved?.includes(key.slice(-20)));
}

/* ------------------------------- the key id ------------------------------- */

test("a key is identified by its last 20 characters, not the whole string", () => {
  const tail = "TAIL0123456789ABCDEF";      // exactly 20 characters
  const long = `sk-ant-api03-${"x".repeat(40)}${tail}`;
  assert.equal(apiKeyId(long), tail);
  assert.equal(apiKeyId(long).length, 20);
  assert.notEqual(apiKeyId(long), long, "the whole key is never the id");
});

test("a key shorter than 20 characters is its own id", () => {
  assert.equal(apiKeyId(DUMMY), DUMMY);
});

test("apiKeyId does not throw on missing input", () => {
  assert.equal(apiKeyId(null), "");
  assert.equal(apiKeyId(undefined), "");
});

/* ------------------------------ the approval ------------------------------ */

test("regression: after approval the CLI would accept our placeholder key", () => {
  const dir = profile();
  approveApiKey(dir, DUMMY);
  assert.equal(cliWouldUseKey(readState(dir), DUMMY), true);
});

test("regression: an unseeded profile is exactly the failing case", () => {
  // No approval written — this is what produced "Not logged in · Run /login".
  assert.equal(cliWouldUseKey({}, DUMMY), false);
  assert.equal(cliWouldUseKey({ customApiKeyResponses: { approved: [], rejected: [] } }, DUMMY), false);
});

test("a long key is approved under its truncated id, as the CLI expects", () => {
  const dir = profile();
  const key = "sk-ant-" + "y".repeat(40) + "ENDING9876543210ABCD";
  approveApiKey(dir, key);
  const state = readState(dir);
  assert.equal(state.customApiKeyResponses.approved[0], "ENDING9876543210ABCD");
  assert.equal(cliWouldUseKey(state, key), true);
});

/* -------------------------------- merging --------------------------------- */

test("onboarding state written earlier in the launch survives", () => {
  const dir = profile();
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
  approveApiKey(dir, DUMMY);
  const state = readState(dir);
  assert.equal(state.hasCompletedOnboarding, true, "seedClaudeProfile's work must not be clobbered");
  assert.equal(cliWouldUseKey(state, DUMMY), true);
});

test("unrelated profile keys are left untouched", () => {
  const dir = profile();
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({
    projects: { "/somewhere": { allowedTools: ["Bash"] } },
    numStartups: 7,
  }));
  approveApiKey(dir, DUMMY);
  const state = readState(dir);
  assert.deepEqual(state.projects, { "/somewhere": { allowedTools: ["Bash"] } });
  assert.equal(state.numStartups, 7);
});

test("another key's approval is preserved, not replaced", () => {
  const dir = profile();
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({
    customApiKeyResponses: { approved: ["SOMEONE-ELSES-KEY-ID"], rejected: [] },
  }));
  approveApiKey(dir, DUMMY);
  const approved = readState(dir).customApiKeyResponses.approved;
  assert.ok(approved.includes("SOMEONE-ELSES-KEY-ID"));
  assert.ok(approved.includes(DUMMY));
});

test("a stale rejection of the same key is cleared", () => {
  const dir = profile();
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({
    customApiKeyResponses: { approved: [], rejected: [DUMMY, "OTHER"] },
  }));
  approveApiKey(dir, DUMMY);
  const r = readState(dir).customApiKeyResponses;
  assert.deepEqual(r.rejected, ["OTHER"], "our key must not remain rejected");
  assert.ok(r.approved.includes(DUMMY));
});

test("approving twice does not duplicate the entry", () => {
  const dir = profile();
  approveApiKey(dir, DUMMY);
  approveApiKey(dir, DUMMY);
  assert.deepEqual(readState(dir).customApiKeyResponses.approved, [DUMMY]);
});

/* ------------------------------- robustness ------------------------------- */

test("a corrupt state file is rebuilt rather than failing the launch", () => {
  const dir = profile();
  writeFileSync(join(dir, ".claude.json"), "{ not json at all");
  approveApiKey(dir, DUMMY);
  assert.equal(cliWouldUseKey(readState(dir), DUMMY), true);
});

test("a state file holding a non-object is replaced", () => {
  for (const junk of ["[1,2,3]", "null", '"a string"']) {
    const dir = profile();
    writeFileSync(join(dir, ".claude.json"), junk);
    approveApiKey(dir, DUMMY);
    assert.equal(cliWouldUseKey(readState(dir), DUMMY), true, junk);
  }
});

test("malformed customApiKeyResponses is repaired", () => {
  const dir = profile();
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ customApiKeyResponses: "nonsense" }));
  approveApiKey(dir, DUMMY);
  assert.equal(cliWouldUseKey(readState(dir), DUMMY), true);
});

test("a profile directory that does not exist yet is created", () => {
  const parent = profile();
  const dir = join(parent, "nested", "cli-profile");
  approveApiKey(dir, DUMMY);
  assert.equal(cliWouldUseKey(readState(dir), DUMMY), true);
});

test("an unwritable profile does not throw — the CLI just prompts instead", () => {
  const dir = profile();
  mkdirSync(join(dir, ".claude.json"), { recursive: true }); // a directory where the file goes
  assert.doesNotThrow(() => approveApiKey(dir, DUMMY));
});
