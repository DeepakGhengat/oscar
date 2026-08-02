import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_PRESETS, formatEnv, probeModels } from "../src/setup.ts";
import type { ProviderId, ProviderPreset } from "../src/setup.ts";

test("PROVIDER_PRESETS: 8 presets with the expected ids and base URLs", () => {
  const ids = PROVIDER_PRESETS.map((p) => p.id);
  assert.deepEqual(ids, [
    "openai", "deepseek", "ollama", "lmstudio", "vllm", "custom",
    "subscription", "passthrough",
  ]);
  const byId = Object.fromEntries(PROVIDER_PRESETS.map((p) => [p.id, p])) as Record<ProviderId, ProviderPreset>;
  assert.equal(byId.openai.baseURL, "https://api.openai.com/v1");
  assert.equal(byId.openai.defaultModel, "gpt-4o-mini");
  assert.equal(byId.deepseek.baseURL, "https://api.deepseek.com/v1");
  assert.equal(byId.ollama.baseURL, "http://localhost:11434/v1");
  assert.equal(byId.lmstudio.baseURL, "http://localhost:1234/v1");
  assert.equal(byId.vllm.baseURL, "http://localhost:8000/v1");
  assert.equal(byId.custom.baseURL, null);
  assert.equal(byId.passthrough.kind, "passthrough");
  // Account sign-in collects nothing: no base URL, no model, no key.
  assert.equal(byId.subscription.kind, "subscription");
  assert.equal(byId.subscription.baseURL, null);
  assert.equal(byId.subscription.keyHint, null);
});

test("formatEnv: cloud config writes OpenAI vars + port", () => {
  const out = formatEnv({
    useOpenAI: true,
    openAIKey: "sk-test",
    openAIModel: "gpt-4o-mini",
    openAIBaseURL: "https://api.openai.com/v1",
    upstreamKey: null,
    port: 8787,
  });
  assert.match(out, /USE_OPENAI_API=1/);
  assert.match(out, /OPENAI_API_KEY=sk-test/);
  assert.match(out, /OPENAI_MODEL=gpt-4o-mini/);
  assert.match(out, /OPENAI_BASE_URL=https:\/\/api\.openai\.com\/v1/);
  assert.match(out, /PROXY_PORT=8787/);
  assert.doesNotMatch(out, /ANTHROPIC_API_KEY/);
});

test("formatEnv: passthrough config writes only anthropic key + port", () => {
  const out = formatEnv({
    useOpenAI: false,
    openAIKey: null,
    openAIModel: null,
    openAIBaseURL: null,
    upstreamKey: "sk-ant",
    port: 8787,
  });
  assert.match(out, /ANTHROPIC_API_KEY=sk-ant/);
  assert.match(out, /PROXY_PORT=8787/);
  assert.doesNotMatch(out, /USE_OPENAI_API=1/);
  assert.doesNotMatch(out, /OPENAI_API_KEY/);
});

test("probeModels: returns parsed model ids on happy path", async () => {
  const fakeFetch = (async (url: string | URL | Request, _init?: RequestInit) => {
    return new Response(JSON.stringify({ data: [{ id: "llama3" }, { id: "qwen2" }] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const ids = await probeModels("http://localhost:11434/v1", fakeFetch);
  assert.deepEqual(ids, ["llama3", "qwen2"]);
});

test("probeModels: returns [] on HTTP error status", async () => {
  const fakeFetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  const ids = await probeModels("http://localhost:11434/v1", fakeFetch);
  assert.deepEqual(ids, []);
});

test("probeModels: returns [] on malformed JSON", async () => {
  const fakeFetch = (async () => new Response("not json", { status: 200 })) as typeof fetch;
  const ids = await probeModels("http://localhost:11434/v1", fakeFetch);
  assert.deepEqual(ids, []);
});

test("probeModels: returns [] when fetch throws", async () => {
  const fakeFetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
  const ids = await probeModels("http://localhost:11434/v1", fakeFetch);
  assert.deepEqual(ids, []);
});