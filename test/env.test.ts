// loadConfig / isOpenAIRouting. Every field, every guard.
//
// Note: importing src/env.ts runs loadEnvFile() once, which may pull the
// developer's own .env into process.env. Each test therefore sets exactly the
// keys it cares about and restores the whole environment afterwards.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, isOpenAIRouting } from "../src/env.ts";

const KEYS = [
  "USE_OPENAI_API",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "OPENAI_BASE_URL",
  "OSCAR_MAX_OUTPUT_TOKENS",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OSCAR_UPSTREAM_BASE_URL",
  "PROXY_PORT",
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Minimum env for OpenAI routing to validate. */
function enableOpenAI(): void {
  process.env.USE_OPENAI_API = "1";
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.OPENAI_MODEL = "qwen2.5:7b";
}

/* ------------------------------ routing flag ------------------------------ */

test("USE_OPENAI_API accepts every documented truthy spelling", () => {
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.OPENAI_MODEL = "m";
  for (const v of ["1", "true", "TRUE", "yes", "on", " On ", "True"]) {
    process.env.USE_OPENAI_API = v;
    assert.equal(loadConfig().useOpenAI, true, `${JSON.stringify(v)} should enable routing`);
  }
});

test("anything else leaves the proxy in passthrough mode", () => {
  for (const v of ["0", "false", "no", "off", "", "  ", "2", "enabled"]) {
    process.env.USE_OPENAI_API = v;
    assert.equal(loadConfig().useOpenAI, false, `${JSON.stringify(v)} must not enable routing`);
  }
  delete process.env.USE_OPENAI_API;
  assert.equal(loadConfig().useOpenAI, false, "unset must not enable routing");
});

test("isOpenAIRouting tracks the flag", () => {
  assert.equal(isOpenAIRouting(), false);
  enableOpenAI();
  assert.equal(isOpenAIRouting(), true);
});

/* ------------------------------- validation ------------------------------- */

test("routing without a key or model fails loudly, not silently", () => {
  process.env.USE_OPENAI_API = "1";
  process.env.OPENAI_MODEL = "m";
  assert.throws(() => loadConfig(), /OPENAI_API_KEY is not set/);

  process.env.OPENAI_API_KEY = "sk-test";
  delete process.env.OPENAI_MODEL;
  assert.throws(() => loadConfig(), /OPENAI_MODEL is not set/);
});

test("passthrough mode needs neither key nor model", () => {
  assert.doesNotThrow(() => loadConfig());
  const cfg = loadConfig();
  assert.equal(cfg.openAIKey, null);
  assert.equal(cfg.openAIModel, null);
});

/* -------------------------------- base URLs ------------------------------- */

test("base URLs lose their trailing slash so path joins can't double up", () => {
  enableOpenAI();
  process.env.OPENAI_BASE_URL = "http://localhost:11434/v1/";
  process.env.OSCAR_UPSTREAM_BASE_URL = "https://api.anthropic.com/";
  const cfg = loadConfig();
  assert.equal(cfg.openAIBaseURL, "http://localhost:11434/v1");
  assert.equal(cfg.upstreamBaseURL, "https://api.anthropic.com");
});

test("OPENAI_BASE_URL defaults to OpenAI proper", () => {
  enableOpenAI();
  assert.equal(loadConfig().openAIBaseURL, "https://api.openai.com/v1");
});

test("OSCAR_UPSTREAM_BASE_URL wins over ANTHROPIC_BASE_URL", () => {
  // ANTHROPIC_BASE_URL points at *us* while the CLI is running, so passthrough
  // must follow the REAL url or it would loop straight back into the proxy.
  process.env.ANTHROPIC_BASE_URL = "http://localhost:8787";
  process.env.OSCAR_UPSTREAM_BASE_URL = "https://api.anthropic.com";
  assert.equal(loadConfig().upstreamBaseURL, "https://api.anthropic.com");

  delete process.env.ANTHROPIC_BASE_URL;
  assert.equal(loadConfig().upstreamBaseURL, "https://api.anthropic.com");
});

test("ANTHROPIC_BASE_URL is used when it points somewhere else", () => {
  // A genuine alternate Anthropic endpoint (gateway, mock) must be honored.
  process.env.ANTHROPIC_BASE_URL = "https://gateway.example.com";
  assert.equal(loadConfig().upstreamBaseURL, "https://gateway.example.com");
});

test("a base URL pointing back at this proxy is refused", () => {
  // A stale `ANTHROPIC_BASE_URL=http://localhost:8787` in .env would make
  // passthrough forward to ourselves and spin. Fall back to real Anthropic.
  process.env.PROXY_PORT = "8787";
  for (const self of [
    "http://localhost:8787",
    "http://127.0.0.1:8787",
    "http://[::1]:8787",
    "http://localhost:8787/",
  ]) {
    process.env.ANTHROPIC_BASE_URL = self;
    assert.equal(loadConfig().upstreamBaseURL, "https://api.anthropic.com", `${self} should be refused`);
  }
});

test("the loop guard is port-specific, not host-specific", () => {
  // Another service on loopback is a legitimate target.
  process.env.PROXY_PORT = "8787";
  process.env.ANTHROPIC_BASE_URL = "http://localhost:9999";
  assert.equal(loadConfig().upstreamBaseURL, "http://localhost:9999");
});

test("a self-pointing REAL url falls through to the next candidate", () => {
  process.env.PROXY_PORT = "8787";
  process.env.OSCAR_UPSTREAM_BASE_URL = "http://localhost:8787";
  process.env.ANTHROPIC_BASE_URL = "https://gateway.example.com";
  assert.equal(loadConfig().upstreamBaseURL, "https://gateway.example.com");
});

/* ---------------------------------- port ---------------------------------- */

test("PROXY_PORT parses, and defaults to 8787", () => {
  assert.equal(loadConfig().port, 8787);
  process.env.PROXY_PORT = "9999";
  assert.equal(loadConfig().port, 9999);
});

/* --------------------------- output-token clamp --------------------------- */

test("OSCAR_MAX_OUTPUT_TOKENS is honored when it's a usable number", () => {
  enableOpenAI();
  process.env.OSCAR_MAX_OUTPUT_TOKENS = "4096";
  assert.equal(loadConfig().maxOutputTokens, 4096);
});

test("a missing or nonsense clamp means no clamp, never a broken one", () => {
  enableOpenAI();
  // An accidental `OSCAR_MAX_OUTPUT_TOKENS=abc` must not become NaN and silently
  // zero out every request's max_tokens.
  for (const v of ["", "   ", "abc", "0", "-1", "NaN"]) {
    process.env.OSCAR_MAX_OUTPUT_TOKENS = v;
    assert.equal(loadConfig().maxOutputTokens, null, `${JSON.stringify(v)} should disable the clamp`);
  }
  delete process.env.OSCAR_MAX_OUTPUT_TOKENS;
  assert.equal(loadConfig().maxOutputTokens, null);
});

/* ------------------------------ config shape ------------------------------ */

test("loadConfig re-reads process.env on every call", () => {
  // The proxy calls this per request so --switch takes effect without a restart.
  enableOpenAI();
  assert.equal(loadConfig().openAIModel, "qwen2.5:7b");
  process.env.OPENAI_MODEL = "glm-5.2:cloud";
  assert.equal(loadConfig().openAIModel, "glm-5.2:cloud");
});

test("every ProxyConfig field is populated", () => {
  enableOpenAI();
  process.env.OPENAI_BASE_URL = "http://localhost:11434/v1";
  process.env.ANTHROPIC_API_KEY = "ant-key";
  process.env.OSCAR_MAX_OUTPUT_TOKENS = "2048";
  process.env.PROXY_PORT = "8080";
  assert.deepEqual(loadConfig(), {
    useOpenAI: true,
    openAIKey: "sk-test",
    openAIModel: "qwen2.5:7b",
    openAIBaseURL: "http://localhost:11434/v1",
    maxOutputTokens: 2048,
    upstreamKey: "ant-key",
    upstreamBaseURL: "https://api.anthropic.com",
    upstreamAuth: "api-key",
    port: 8080,
  });
});
