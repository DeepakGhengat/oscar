// getCatalog: the networked half of the catalog — probing, memoisation, and
// graceful degradation. globalThis.fetch is stubbed so nothing leaves the box.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { clearCatalogCache, getCatalog } from "../src/catalog.ts";
import type { ProxyConfig } from "../src/types.ts";

const realFetch = globalThis.fetch;

interface Call {
  url: string;
  authorization: string | undefined;
}

let calls: Call[] = [];

/** Stub fetch with a canned /models payload (or a failure). */
function stubFetch(
  handler: (url: string) => { ok: boolean; body?: unknown; throws?: boolean },
): void {
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, authorization: headers.authorization ?? headers.Authorization });
    const r = handler(url);
    if (r.throws) throw new Error("connection refused");
    return new Response(r.ok ? JSON.stringify(r.body) : "nope", {
      status: r.ok ? 200 : 500,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function cfg(over: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    useOpenAI: true,
    openAIKey: "sk-test",
    openAIModel: "qwen2.5:7b",
    openAIBaseURL: "http://localhost:11434/v1",
    maxOutputTokens: null,
    anthropicKey: null,
    anthropicBaseURL: "https://api.anthropic.com",
    port: 8787,
    ...over,
  };
}

const OK = (ids: string[]) => () => ({ ok: true, body: { data: ids.map((id) => ({ id })) } });

beforeEach(() => {
  calls = [];
  clearCatalogCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearCatalogCache();
});

test("getCatalog probes {baseURL}/models and aliases what it finds", async () => {
  stubFetch(OK(["glm-5.2:cloud", "qwen2.5:7b"]));
  const c = await getCatalog(cfg());
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "http://localhost:11434/v1/models");
  assert.deepEqual(c.entries.map((e) => e.id).sort(), ["glm-5.2:cloud", "qwen2.5:7b"]);
});

test("the API key is sent as a bearer token", async () => {
  stubFetch(OK(["m"]));
  await getCatalog(cfg({ openAIKey: "sk-secret" }));
  assert.equal(calls[0]!.authorization, "Bearer sk-secret");
});

test("a keyless backend is probed without an Authorization header", async () => {
  stubFetch(OK(["m"]));
  await getCatalog(cfg({ openAIKey: null }));
  assert.equal(calls[0]!.authorization, undefined);
});

test("results are memoised — one probe serves many requests", async () => {
  stubFetch(OK(["a", "b"]));
  const c = cfg();
  await getCatalog(c);
  await getCatalog(c);
  await getCatalog(c);
  assert.equal(calls.length, 1, "every /v1/messages must not re-probe the backend");
});

test("changing the backend URL invalidates the memo", async () => {
  stubFetch(OK(["a"]));
  await getCatalog(cfg({ openAIBaseURL: "http://localhost:11434/v1" }));
  await getCatalog(cfg({ openAIBaseURL: "https://ollama.com/v1" }));
  assert.equal(calls.length, 2);
});

test("changing the API key invalidates the memo", async () => {
  // A different key can expose a different model set on the same host.
  stubFetch(OK(["a"]));
  await getCatalog(cfg({ openAIKey: "sk-one" }));
  await getCatalog(cfg({ openAIKey: "sk-two" }));
  assert.equal(calls.length, 2);
});

test("clearCatalogCache forces the next call to re-probe", async () => {
  stubFetch(OK(["a"]));
  await getCatalog(cfg());
  clearCatalogCache();
  await getCatalog(cfg());
  assert.equal(calls.length, 2);
});

test("an unreachable backend yields an empty catalog, not an exception", async () => {
  // Requests must keep working (falling back to OPENAI_MODEL) when the
  // backend's model listing is down.
  stubFetch(() => ({ ok: false, throws: true }));
  const c = await getCatalog(cfg());
  assert.deepEqual(c.entries, []);
  assert.equal(c.byAlias.size, 0);
});

test("an HTTP error from /models yields an empty catalog", async () => {
  stubFetch(() => ({ ok: false }));
  const c = await getCatalog(cfg());
  assert.deepEqual(c.entries, []);
});

test("a failed probe is not cached as success", async () => {
  let up = false;
  stubFetch(() => (up ? { ok: true, body: { data: [{ id: "a" }] } } : { ok: false, throws: true }));
  assert.deepEqual((await getCatalog(cfg())).entries, []);
  up = true;
  const c = await getCatalog(cfg());
  assert.deepEqual(
    c.entries.map((e) => e.id),
    ["a"],
    "a backend that comes back up must be picked up, not masked by a cached failure",
  );
});

test("the advertised list is sorted for a stable picker order", async () => {
  stubFetch(OK(["zephyr", "alpha", "mistral"]));
  const c = await getCatalog(cfg());
  assert.deepEqual(c.entries.map((e) => e.id), ["alpha", "mistral", "zephyr"]);
});

test("embedding models are filtered out of the probe result", async () => {
  stubFetch(OK(["nomic-embed-text:v1.5", "qwen2.5:7b"]));
  const c = await getCatalog(cfg());
  assert.deepEqual(c.entries.map((e) => e.id), ["qwen2.5:7b"]);
});
