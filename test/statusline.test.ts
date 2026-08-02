// What the status line reports as active.
//
// The CLI passes the session's real model on stdin:
//   { model: { id, display_name }, workspace: { current_dir } }
//
// The status line used to ignore that and report the proxy's configured
// OPENAI_MODEL instead — a different thing entirely. That value is the
// *default* backend model and does not change when you pick something else
// from /model, so the line read `glm-5.2:cloud` while the session was on
// Opus 5. Worst in hybrid, where both are legitimate destinations and the
// line was the only way to tell them apart.

import { test } from "node:test";
import assert from "node:assert/strict";
import { describeActive, shortPath } from "../bin/oscar-statusline.mjs";

const CAT = {
  entries: [
    { provider: "cloud", model: "glm-5.2:cloud", alias: "claude-oscar-cloud-glm-5.2-cloud" },
    { provider: "local", model: "qwen2.5:7b", alias: "claude-oscar-local-qwen2.5-7b" },
  ],
  providers: 2,
};

const session = (id: string, display?: string) => ({
  model: { id, display_name: display ?? id },
});

/* ------------------------- the model actually in use ---------------------- */

test("a backend model is shown under its real name and provider", () => {
  const a = describeActive(session("claude-oscar-cloud-glm-5.2-cloud"), CAT);
  assert.deepEqual(a, { label: "glm-5.2:cloud", via: "cloud", backend: true });
});

test("switching backend model changes what is reported", () => {
  // The regression: this used to read the .env default, so both selections
  // rendered identically.
  const first = describeActive(session("claude-oscar-cloud-glm-5.2-cloud"), CAT);
  const second = describeActive(session("claude-oscar-local-qwen2.5-7b"), CAT);
  assert.notEqual(first!.label, second!.label);
  assert.equal(second!.label, "qwen2.5:7b");
  assert.equal(second!.via, "local");
});

test("a real backend id typed directly resolves too", () => {
  const a = describeActive(session("qwen2.5:7b"), CAT);
  assert.deepEqual(a, { label: "qwen2.5:7b", via: "local", backend: true });
});

/* --------------------------------- hybrid --------------------------------- */

test("an Anthropic model is reported as going to the vendor, not a backend", () => {
  const a = describeActive(session("claude-opus-5", "Opus 5 (1M context)"), CAT);
  assert.equal(a!.label, "Opus 5 (1M context)");
  assert.equal(a!.via, "anthropic");
  assert.equal(a!.backend, false);
});

test("the two halves of hybrid are distinguishable", () => {
  const backend = describeActive(session("claude-oscar-local-qwen2.5-7b"), CAT);
  const vendor = describeActive(session("claude-opus-5", "Opus 5"), CAT);
  assert.equal(backend!.backend, true);
  assert.equal(vendor!.backend, false);
  assert.notEqual(backend!.via, vendor!.via);
});

test("our alias prefix does not make a vendor model look like a backend one", () => {
  // Both start with `claude-`; only one is ours.
  assert.equal(describeActive(session("claude-opus-4"), CAT)!.backend, false);
});

/* ------------------------- no proxy / no payload -------------------------- */

test("with no proxy the session's own model is still reported", () => {
  // Account sign-in runs no proxy. Reporting "proxy offline" there was noise:
  // nothing is wrong, and the model is known.
  const a = describeActive(session("claude-opus-5", "Opus 5"), null);
  assert.equal(a!.label, "Opus 5");
  assert.equal(a!.backend, false);
});

test("a payload with no model yields nothing rather than a guess", () => {
  assert.equal(describeActive({}, CAT), null);
  assert.equal(describeActive(null, CAT), null);
  assert.equal(describeActive({ model: {} }, null), null);
});

test("an id with no display_name still renders", () => {
  const a = describeActive({ model: { id: "claude-opus-5" } }, null);
  assert.equal(a!.label, "claude-opus-5");
});

test("an empty catalog does not crash the lookup", () => {
  const a = describeActive(session("claude-oscar-cloud-glm-5.2-cloud"), { entries: [], providers: 0 });
  assert.equal(a!.backend, false, "unresolvable, so reported as vendor-bound");
});

/* -------------------------------- the path -------------------------------- */

test("long paths are trimmed to the tail", () => {
  assert.equal(shortPath("/a/b/c/d/e"), "…/d/e");
  assert.equal(shortPath("D:\\oscar"), "D:/oscar");
  assert.equal(shortPath(""), "");
  assert.equal(shortPath(undefined), "");
});
