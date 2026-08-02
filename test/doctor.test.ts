// The doctor has to report the config a real launch would use, not just what
// is written in the file — otherwise `USE_OPENAI_API=1 oscar --doctor` checks
// one setup while `USE_OPENAI_API=1 oscar` runs another.

import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveEnv } from "../src/doctor.ts";

test("the file supplies values when the shell says nothing", () => {
  const out = effectiveEnv({ OPENAI_MODEL: "qwen2.5:7b", PROXY_PORT: "8787" }, {});
  assert.equal(out.OPENAI_MODEL, "qwen2.5:7b");
  assert.equal(out.PROXY_PORT, "8787");
});

test("a shell variable overrides the file, matching loadEnvFile", () => {
  // loadEnvFile only fills in keys not already set, so the shell wins there.
  const out = effectiveEnv({ USE_OPENAI_API: "0" }, { USE_OPENAI_API: "1" });
  assert.equal(out.USE_OPENAI_API, "1");
});

test("a shell variable absent from the file is still picked up", () => {
  // `USE_OPENAI_API=1 oscar` against a subscription-only config.
  const out = effectiveEnv({ OSCAR_AUTH: "subscription" }, { USE_OPENAI_API: "1" });
  assert.equal(out.USE_OPENAI_API, "1");
  assert.equal(out.OSCAR_AUTH, "subscription");
});

test("every routing-relevant key is overridable", () => {
  const shell = {
    USE_OPENAI_API: "1",
    OSCAR_AUTH: "api-key",
    OPENAI_BASE_URL: "http://shell/v1",
    OPENAI_API_KEY: "shell-key",
    OPENAI_MODEL: "shell-model",
    ANTHROPIC_API_KEY: "shell-ant",
    PROXY_PORT: "9999",
  };
  const out = effectiveEnv({ OPENAI_MODEL: "file-model" }, shell);
  for (const [k, v] of Object.entries(shell)) assert.equal(out[k], v, `${k} should come from the shell`);
});

test("an undefined shell value does not blank out the file", () => {
  const out = effectiveEnv({ OPENAI_MODEL: "from-file" }, { OPENAI_MODEL: undefined });
  assert.equal(out.OPENAI_MODEL, "from-file");
});

test("an empty-string shell value is respected, not treated as unset", () => {
  // `OPENAI_API_KEY= oscar` is a deliberate way to drop a key.
  const out = effectiveEnv({ OPENAI_API_KEY: "from-file" }, { OPENAI_API_KEY: "" });
  assert.equal(out.OPENAI_API_KEY, "");
});

test("keys unique to the file survive the overlay", () => {
  const out = effectiveEnv({ OSCAR_MAX_OUTPUT_TOKENS: "4096" }, { USE_OPENAI_API: "1" });
  assert.equal(out.OSCAR_MAX_OUTPUT_TOKENS, "4096");
});
