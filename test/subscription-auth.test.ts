// Account sign-in (Pro / Max / Team / enterprise SSO).
//
// The CLI authenticates itself against the vendor cloud and sends short-lived
// OAuth credentials as `Authorization: Bearer …`, with no `x-api-key` at all.
// The proxy used to force `x-api-key: cfg.upstreamKey ?? ""` onto every
// passthrough request, so a signed-in CLI arrived at the API carrying a valid
// bearer token *and* an empty api-key header — which the API rejects. These
// tests pin the fix: we only ever fill a gap, never overwrite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { callerIsAuthenticated, upstreamAuthHeaders } from "../src/proxy.ts";
import { resolveUpstreamAuth } from "../src/env.ts";
import { formatEnv } from "../src/setup.ts";
import { hasStoredLogin } from "../src/doctor.ts";
import type { ProxyConfig } from "../src/types.ts";

function cfg(over: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    useOpenAI: false,
    openAIKey: null,
    openAIModel: null,
    openAIBaseURL: "https://api.openai.com/v1",
    maxOutputTokens: null,
    upstreamKey: null,
    upstreamBaseURL: "https://api.anthropic.com",
    upstreamAuth: "api-key",
    port: 8787,
    ...over,
  };
}

const BEARER = "Bearer sk-ant-oat01-subscription-token";

/* --------------------------- auth mode resolution ------------------------- */

test("resolveUpstreamAuth: an explicit setting wins over inference", () => {
  assert.equal(resolveUpstreamAuth("subscription", "sk-ant-key"), "subscription");
  assert.equal(resolveUpstreamAuth("api-key", null), "api-key");
});

test("resolveUpstreamAuth: the friendly spellings all mean sign-in", () => {
  for (const v of ["subscription", "oauth", "sso", "login", "SSO", " OAuth "]) {
    assert.equal(resolveUpstreamAuth(v, null), "subscription", v);
  }
  for (const v of ["api-key", "apikey", "key", "API-KEY"]) {
    assert.equal(resolveUpstreamAuth(v, null), "api-key", v);
  }
});

test("resolveUpstreamAuth: no key configured means the CLI signs itself in", () => {
  assert.equal(resolveUpstreamAuth(undefined, null), "subscription");
  assert.equal(resolveUpstreamAuth("", null), "subscription");
  assert.equal(resolveUpstreamAuth(undefined, "sk-ant-key"), "api-key");
});

test("resolveUpstreamAuth: an unrecognised value falls back to inference", () => {
  assert.equal(resolveUpstreamAuth("banana", "sk-ant-key"), "api-key");
  assert.equal(resolveUpstreamAuth("banana", null), "subscription");
});

/* ------------------------- caller credential detection -------------------- */

test("callerIsAuthenticated: a bearer token counts", () => {
  assert.equal(callerIsAuthenticated(new Headers({ authorization: BEARER })), true);
});

test("callerIsAuthenticated: an api key counts", () => {
  assert.equal(callerIsAuthenticated(new Headers({ "x-api-key": "sk-ant-key" })), true);
});

test("callerIsAuthenticated: blank or absent headers do not count", () => {
  assert.equal(callerIsAuthenticated(new Headers()), false);
  assert.equal(callerIsAuthenticated(new Headers({ authorization: "   " })), false);
  assert.equal(callerIsAuthenticated(new Headers({ "x-api-key": "" })), false);
});

/* ----------------------------- header assembly ---------------------------- */

test("subscription mode never contributes an api key", () => {
  const h = upstreamAuthHeaders(cfg({ upstreamAuth: "subscription", upstreamKey: "sk-ant-ours" }));
  assert.equal("x-api-key" in h, false);
  assert.equal(h["anthropic-version"], "2023-06-01");
});

test("a signed-in caller's credentials are never displaced", () => {
  const h = upstreamAuthHeaders(
    cfg({ upstreamAuth: "api-key", upstreamKey: "sk-ant-ours" }),
    new Headers({ authorization: BEARER }),
  );
  // The regression: our key must not ride along beside the bearer token.
  assert.equal("x-api-key" in h, false);
});

test("no empty api-key is ever produced when we hold no key", () => {
  for (const incoming of [undefined, new Headers(), new Headers({ authorization: BEARER })]) {
    const h = upstreamAuthHeaders(cfg({ upstreamKey: null }), incoming);
    assert.equal("x-api-key" in h, false, String(incoming?.get("authorization")));
  }
});

test("api-key mode still supplies the key when the caller sent none", () => {
  const h = upstreamAuthHeaders(cfg({ upstreamKey: "sk-ant-ours" }), new Headers());
  assert.equal(h["x-api-key"], "sk-ant-ours");
});

test("the protocol headers are set in every mode", () => {
  for (const mode of ["api-key", "subscription"] as const) {
    const h = upstreamAuthHeaders(cfg({ upstreamAuth: mode, upstreamKey: "k" }));
    assert.equal(h["anthropic-version"], "2023-06-01");
    assert.equal(h["anthropic-dangerous-direct-browser-access"], "true");
  }
});

/* --------------------------------- config --------------------------------- */

test("formatEnv: sign-in writes the auth mode and stores no key", () => {
  const out = formatEnv({
    useOpenAI: false, openAIKey: null, openAIModel: null, openAIBaseURL: null,
    upstreamKey: null, subscription: true, port: 8787,
  });
  assert.match(out, /^OSCAR_AUTH=subscription$/m);
  assert.doesNotMatch(out, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(out, /USE_OPENAI_API/);
});

test("formatEnv: sign-in records no port, because no proxy ever binds one", () => {
  const out = formatEnv({
    useOpenAI: false, openAIKey: null, openAIModel: null, openAIBaseURL: null,
    upstreamKey: null, subscription: true, port: 8787,
  });
  assert.doesNotMatch(out, /PROXY_PORT/);
  // The whole config is the comment and the mode — nothing else applies.
  assert.equal(out.trim().split("\n").length, 2);
});

test("formatEnv: every mode that does run a proxy still records its port", () => {
  for (const cfg of [
    { useOpenAI: false, openAIKey: null, openAIModel: null, openAIBaseURL: null, upstreamKey: "sk-ant-x", port: 9000 },
    { useOpenAI: true, openAIKey: "sk", openAIModel: "m", openAIBaseURL: "http://x/v1", upstreamKey: null, port: 9000 },
  ]) {
    assert.match(formatEnv(cfg), /^PROXY_PORT=9000$/m, JSON.stringify(cfg));
  }
});

test("formatEnv: an api key config does not claim to be a sign-in", () => {
  const out = formatEnv({
    useOpenAI: false, openAIKey: null, openAIModel: null, openAIBaseURL: null,
    upstreamKey: "sk-ant-key", port: 8787,
  });
  assert.match(out, /^ANTHROPIC_API_KEY=sk-ant-key$/m);
  assert.doesNotMatch(out, /OSCAR_AUTH/);
});

/* --------------------------------- doctor --------------------------------- */

test("hasStoredLogin: declines to guess on macOS, where the keychain holds it", () => {
  assert.equal(hasStoredLogin("/home/nobody", "darwin"), null);
});

test("hasStoredLogin: false when the CLI has no config directory at all", () => {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    assert.equal(hasStoredLogin("/nonexistent-home-xyz", "linux"), false);
  } finally {
    if (prev !== undefined) process.env.CLAUDE_CONFIG_DIR = prev;
  }
});
