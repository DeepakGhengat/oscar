// getCatalog: the networked half of the catalog — probing, memoisation, and
// graceful degradation. globalThis.fetch is stubbed so nothing leaves the box.

import { test, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearCatalogCache,
  getCatalog,
  warmCatalog,
  PROBE_TIMEOUT_REQUEST_MS,
  PROBE_TIMEOUT_WARM_MS,
} from "../src/catalog.ts";
import type { ProxyConfig } from "../src/types.ts";

const realFetch = globalThis.fetch;

/** How long a partial catalog is cached before a retry. Mirrors src/catalog.ts. */
const TTL_PARTIAL_MS = 5_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A config dir holding a two-provider providers.json, for the tests that need one. */
let providerDir = "";
let prevConfigDir: string | undefined;

before(() => {
  prevConfigDir = process.env.CLAUDE_CODE_FREE_CONFIG;
  providerDir = mkdtempSync(join(tmpdir(), "ccf-probe-"));
  writeFileSync(
    join(providerDir, "providers.json"),
    JSON.stringify({
      providers: {
        local: { baseURL: "http://local/v1", apiKey: "k1" },
        cloud: { baseURL: "http://cloud/v1", apiKey: "k2" },
      },
    }),
  );
});

after(() => {
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CODE_FREE_CONFIG;
  else process.env.CLAUDE_CODE_FREE_CONFIG = prevConfigDir;
  try {
    rmSync(providerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* cosmetic */
  }
});

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
  // Most tests exercise the flat single-provider path; the multi-provider ones
  // opt in by pointing at providerDir.
  delete process.env.CLAUDE_CODE_FREE_CONFIG;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearCatalogCache();
  delete process.env.CLAUDE_CODE_FREE_CONFIG;
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

/* --------------------------- probe budgets -------------------------------- */

test("the request path probes within Claude Code's 3s discovery timeout", async () => {
  // Claude Code aborts its /v1/models fetch after 3s; anything longer means an
  // empty picker for the whole session.
  assert.ok(
    PROBE_TIMEOUT_REQUEST_MS < 3000,
    `${PROBE_TIMEOUT_REQUEST_MS}ms would outlast the CLI's own timeout`,
  );
});

test("startup warm-up gets a longer budget than the request path", async () => {
  // A remote backend pays DNS + TLS on its first request; 2.5s can cut it off.
  assert.ok(PROBE_TIMEOUT_WARM_MS > PROBE_TIMEOUT_REQUEST_MS);
});

test("warmCatalog fills the cache so the first request is served from it", async () => {
  stubFetch(OK(["a", "b"]));
  await warmCatalog(cfg());
  assert.equal(calls.length, 1);
  const c = await getCatalog(cfg());
  assert.equal(calls.length, 1, "the request path must reuse the warmed catalog");
  assert.deepEqual(c.entries.map((e) => e.id), ["a", "b"]);
});

test("a partial result is retried sooner than a complete one", async () => {
  // Regression: a slow backend dropped out of a cached catalog for a full 60s,
  // and Claude Code only fetches the picker once — so it stayed missing.
  process.env.CLAUDE_CODE_FREE_CONFIG = providerDir;
  let cloudUp = false;
  stubFetch((url) => {
    if (url.startsWith("http://local")) return { ok: true, body: { data: [{ id: "local-model" }] } };
    return cloudUp ? { ok: true, body: { data: [{ id: "cloud-model" }] } } : { ok: false, throws: true };
  });

  const partial = await getCatalog(cfg());
  assert.deepEqual(partial.unreachable, ["cloud"]);
  assert.equal(partial.entries.length, 1);

  // Within the short partial TTL the cache is reused...
  const cachedCalls = calls.length;
  await getCatalog(cfg());
  assert.equal(calls.length, cachedCalls, "still inside the partial TTL");

  // ...but it expires quickly, and the recovered backend reappears.
  cloudUp = true;
  await sleep(TTL_PARTIAL_MS + 200);
  const full = await getCatalog(cfg());
  assert.deepEqual(full.unreachable, []);
  assert.deepEqual(full.entries.map((e) => e.id).sort(), ["cloud-model", "local-model"]);
});

test("providers are probed concurrently, not one after another", async () => {
  process.env.CLAUDE_CODE_FREE_CONFIG = providerDir;
  let inFlight = 0;
  let maxInFlight = 0;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(60);
    inFlight--;
    return new Response(JSON.stringify({ data: [{ id: String(input).includes("local") ? "a" : "b" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  await getCatalog(cfg());
  assert.equal(maxInFlight, 2, "a slow backend must not serialise behind another");
});
