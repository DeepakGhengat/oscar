// Preflight: the check that catches a placeholder API key on a backend whose
// /models listing is public. This exists because a real misconfiguration got
// all the way to a live conversation before failing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isPlaceholderKey, isRemoteBackend, verifyBackend } from "../src/preflight.ts";

/** Fake fetch that returns a fixed status, recording what it was sent. */
function fakeFetch(status: number, body = "{}") {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    seen.push({ url: String(url), init: init as RequestInit });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, seen };
}

/* ------------------------------ placeholders ------------------------------ */

test("preset default keys are recognised as placeholders", () => {
  for (const k of ["ollama", "lm-studio", "lmstudio", "vllm", "none", ""]) {
    assert.equal(isPlaceholderKey(k), true, `${JSON.stringify(k)} should be a placeholder`);
  }
});

test("placeholder detection ignores case and surrounding space", () => {
  assert.equal(isPlaceholderKey("  Ollama "), true);
});

test("a real-looking key is not a placeholder", () => {
  assert.equal(isPlaceholderKey("sk-proj-abc123def456"), false);
  assert.equal(isPlaceholderKey("6a1f2b9c4e"), false);
});

test("null and undefined count as placeholders", () => {
  assert.equal(isPlaceholderKey(null), true);
  assert.equal(isPlaceholderKey(undefined), true);
});

/* ----------------------------- remote backends ---------------------------- */

test("localhost backends are local", () => {
  for (const u of ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://[::1]:8000/v1"]) {
    assert.equal(isRemoteBackend(u), false, `${u} should be local`);
  }
});

test("hosted backends are remote", () => {
  for (const u of ["https://ollama.com/v1", "https://api.openai.com/v1", "https://api.deepseek.com/v1"]) {
    assert.equal(isRemoteBackend(u), true, `${u} should be remote`);
  }
});

test("an unparseable base URL is not claimed to be remote", () => {
  assert.equal(isRemoteBackend("not a url"), false);
});

/* ------------------------------- verification ----------------------------- */

test("verifyBackend sends a real, minimal completion", async () => {
  const { impl, seen } = fakeFetch(200);
  await verifyBackend({ baseURL: "https://ollama.com/v1", apiKey: "k", model: "glm-5.2" }, impl);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "https://ollama.com/v1/chat/completions");
  const body = JSON.parse(String(seen[0]!.init!.body));
  assert.equal(body.model, "glm-5.2");
  assert.equal(body.max_tokens, 1, "the check must not burn tokens");
});

test("a trailing slash on the base URL does not double up the path", async () => {
  const { impl, seen } = fakeFetch(200);
  await verifyBackend({ baseURL: "https://ollama.com/v1/", apiKey: "k", model: "m" }, impl);
  assert.equal(seen[0]!.url, "https://ollama.com/v1/chat/completions");
});

test("the key is sent as a bearer token, and omitted when absent", async () => {
  const withKey = fakeFetch(200);
  await verifyBackend({ baseURL: "http://h/v1", apiKey: "secret", model: "m" }, withKey.impl);
  assert.equal((withKey.seen[0]!.init!.headers as Record<string, string>).authorization, "Bearer secret");

  const noKey = fakeFetch(200);
  await verifyBackend({ baseURL: "http://h/v1", apiKey: null, model: "m" }, noKey.impl);
  assert.equal((noKey.seen[0]!.init!.headers as Record<string, string>).authorization, undefined);
});

test("200 means the backend genuinely works", async () => {
  const r = await verifyBackend({ baseURL: "http://h/v1", apiKey: "k", model: "m" }, fakeFetch(200).impl);
  assert.equal(r.ok, true);
  assert.equal(r.kind, "ok");
});

test("401 and 403 are reported as auth failures", async () => {
  for (const status of [401, 403]) {
    const r = await verifyBackend(
      { baseURL: "https://ollama.com/v1", apiKey: "real-key", model: "m" },
      fakeFetch(status, '{"error":"Unauthorized"}').impl,
    );
    assert.equal(r.ok, false);
    assert.equal(r.kind, "auth");
    assert.equal(r.status, status);
  }
});

test("an auth failure on a placeholder key names the placeholder", async () => {
  // This is the message that would have saved a debugging session.
  const r = await verifyBackend(
    { baseURL: "https://ollama.com/v1", apiKey: "ollama", model: "glm-5.2" },
    fakeFetch(401, '{"error":"Unauthorized"}').impl,
  );
  assert.equal(r.kind, "auth");
  assert.match(r.message, /placeholder/);
  assert.match(r.message, /"ollama"/);
});

test("404 is reported as a bad model name, not a bad key", async () => {
  const r = await verifyBackend({ baseURL: "http://h/v1", apiKey: "k", model: "nope" }, fakeFetch(404).impl);
  assert.equal(r.kind, "model");
  assert.match(r.message, /nope/);
});

test("other HTTP errors keep their status and body", async () => {
  const r = await verifyBackend(
    { baseURL: "http://h/v1", apiKey: "k", model: "m" },
    fakeFetch(500, "upstream exploded").impl,
  );
  assert.equal(r.kind, "http");
  assert.equal(r.status, 500);
  assert.match(r.message, /upstream exploded/);
});

test("a network failure is reported as unreachable, not as bad auth", async () => {
  const impl = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const r = await verifyBackend({ baseURL: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" }, impl);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "unreachable");
  assert.equal(r.status, null);
  assert.match(r.message, /ECONNREFUSED/);
});

test("the real-world case: public listing, private completions", async () => {
  // /models answers 200 to anyone on Ollama Cloud, so only the completion
  // distinguishes a working key from a placeholder.
  const r = await verifyBackend(
    { baseURL: "https://ollama.com/v1", apiKey: "ollama", model: "glm-5.2" },
    fakeFetch(401, '{"error":"Unauthorized"}').impl,
  );
  assert.equal(r.ok, false, "a placeholder key must not be reported as working");
});
