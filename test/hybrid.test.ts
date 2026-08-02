// Hybrid: one `/model` list spanning both worlds.
//
// Before this, the two halves were mutually exclusive. In OpenAI-routing mode
// every request went to a backend — including one naming an Anthropic tier,
// which was silently answered by whichever backend happened to be the default.
// In Anthropic mode there was no proxy at all, so `/model` showed only the
// vendor's own models. Switching meant editing config and restarting.
//
// Hybrid routes per request, on the model id:
//   an alias we advertised, or a real backend id  -> the backend, translated
//   anything else (an Anthropic tier)             -> the vendor, untouched
//
// The Anthropic half rides on the CLI's own credentials, which is why the
// launcher must not substitute a placeholder key or a throwaway profile here.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildCatalog } from "../src/catalog.ts";
import { isBackendModel } from "../src/proxy.ts";
import { loadConfig } from "../src/env.ts";
import { formatEnv } from "../src/setup.ts";
import { isHybrid } from "../bin/oscar.mjs";
import type { ProxyConfig } from "../src/types.ts";

const KEYS = ["USE_OPENAI_API", "OSCAR_AUTH", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL"];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

function openAIEnv(): void {
  process.env.USE_OPENAI_API = "1";
  process.env.OPENAI_API_KEY = "k";
  process.env.OPENAI_MODEL = "glm-5.2:cloud";
  process.env.OPENAI_BASE_URL = "http://localhost:11434/v1";
  delete process.env.OSCAR_AUTH;
  delete process.env.ANTHROPIC_API_KEY;
}

/* ------------------------------ when it is on ----------------------------- */

test("hybrid needs the Anthropic side configured on purpose", () => {
  openAIEnv();
  assert.equal(loadConfig().hybrid, false, "a plain OpenAI setup must not become hybrid");

  process.env.OSCAR_AUTH = "subscription";
  assert.equal(loadConfig().hybrid, true);
});

test("an API key also counts as configuring the Anthropic side", () => {
  openAIEnv();
  process.env.ANTHROPIC_API_KEY = "sk-ant-x";
  assert.equal(loadConfig().hybrid, true);
});

test("hybrid is off whenever the proxy is not routing to a backend", () => {
  openAIEnv();
  process.env.OSCAR_AUTH = "subscription";
  process.env.USE_OPENAI_API = "0";
  assert.equal(loadConfig().hybrid, false, "with no backend there is nothing to be hybrid with");
});

test("the launcher agrees with the proxy about when hybrid applies", () => {
  // Two implementations of one rule; they must not drift.
  const cases: Array<Record<string, string>> = [
    { USE_OPENAI_API: "1" },
    { USE_OPENAI_API: "1", OSCAR_AUTH: "subscription" },
    { USE_OPENAI_API: "1", OSCAR_AUTH: "sso" },
    { USE_OPENAI_API: "1", ANTHROPIC_API_KEY: "sk-ant-x" },
    { USE_OPENAI_API: "0", OSCAR_AUTH: "subscription" },
    { OSCAR_AUTH: "subscription" },
  ];
  for (const env of cases) {
    openAIEnv();
    for (const k of KEYS) if (!(k in env) && k !== "OPENAI_API_KEY" && k !== "OPENAI_MODEL" && k !== "OPENAI_BASE_URL") delete process.env[k];
    Object.assign(process.env, env);
    assert.equal(
      loadConfig().hybrid,
      isHybrid(process.env),
      `disagreement for ${JSON.stringify(env)}`,
    );
  }
});

/* ------------------------------- the routing ------------------------------ */

const provider = { id: "default", baseURL: "http://localhost:11434/v1", apiKey: "k" };
const catalog = buildCatalog([{ provider, ids: ["glm-5.2:cloud", "qwen2.5:7b"] }]);

function cfg(over: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    useOpenAI: true, openAIKey: "k", openAIModel: "glm-5.2:cloud",
    openAIBaseURL: "http://localhost:11434/v1", maxOutputTokens: null,
    upstreamKey: null, upstreamBaseURL: "https://api.anthropic.com",
    upstreamAuth: "subscription", hybrid: true, port: 8787, ...over,
  };
}

/** The routing decision, without the network: what isBackendModel checks. */
function goesToBackend(model: string | undefined): boolean {
  if (!model) return false;
  if (catalog.byAlias.has(model)) return true;
  return catalog.entries.some((e) => e.id === model);
}

test("an advertised alias routes to the backend", () => {
  for (const e of catalog.entries) assert.equal(goesToBackend(e.alias), true, e.alias);
});

test("a real backend id typed straight into /model routes to the backend", () => {
  assert.equal(goesToBackend("glm-5.2:cloud"), true);
  assert.equal(goesToBackend("qwen2.5:7b"), true);
});

test("an Anthropic tier id does not route to the backend", () => {
  for (const id of ["claude-opus-5", "claude-sonnet-4-5", "claude-3-5-haiku-20241022"]) {
    assert.equal(goesToBackend(id), false, id);
  }
});

test("our alias prefix does not make every claude- id look like ours", () => {
  // Aliases start with `claude-oscar-`; the vendor's own ids share only the
  // leading token, and must not be captured by it.
  assert.equal(goesToBackend("claude-oscar-glm-5.2-cloud"), true);
  assert.equal(goesToBackend("claude-opus-4"), false);
});

test("isBackendModel says no when nothing is configured", async () => {
  assert.equal(await isBackendModel(cfg(), undefined), false);
});

/* -------------------------------- the config ------------------------------ */

test("the wizard writes both halves for hybrid", () => {
  const out = formatEnv({
    useOpenAI: true, openAIKey: "k", openAIModel: "glm-5.2:cloud",
    openAIBaseURL: "https://ollama.com/v1", upstreamKey: null, hybrid: true, port: 8787,
  });
  assert.match(out, /^USE_OPENAI_API=1$/m, "the backend half");
  assert.match(out, /^OSCAR_AUTH=subscription$/m, "the Anthropic half");
  assert.match(out, /^PROXY_PORT=8787$/m, "hybrid runs a proxy, so it needs a port");
});

test("declining hybrid leaves a plain backend config", () => {
  const out = formatEnv({
    useOpenAI: true, openAIKey: "k", openAIModel: "m",
    openAIBaseURL: "https://ollama.com/v1", upstreamKey: null, hybrid: false, port: 8787,
  });
  assert.doesNotMatch(out, /OSCAR_AUTH/);
});

test("pure account sign-in is still portless and keyless", () => {
  const out = formatEnv({
    useOpenAI: false, openAIKey: null, openAIModel: null, openAIBaseURL: null,
    upstreamKey: null, subscription: true, port: 8787,
  });
  assert.match(out, /^OSCAR_AUTH=subscription$/m);
  assert.doesNotMatch(out, /PROXY_PORT/);
  assert.doesNotMatch(out, /USE_OPENAI_API/);
});

/* --------------------------- the --model flag ----------------------------- */

test("bare --model is our picker; --model <id> belongs to the CLI", async () => {
  const { isBareModelFlag } = await import("../bin/oscar.mjs");
  assert.equal(isBareModelFlag(["--model"]), true, "bare form opens our picker");
  assert.equal(isBareModelFlag(["--model", "--verbose"]), true, "a flag is not a model id");
  assert.equal(isBareModelFlag([]), false);
  // Regression: this used to open the picker and discard the id, so the one
  // command that names a model directly silently did something else.
  assert.equal(isBareModelFlag(["--model", "claude-oscar-glm-5.2-cloud"]), false);
  assert.equal(isBareModelFlag(["--model", "opus"]), false);
});
