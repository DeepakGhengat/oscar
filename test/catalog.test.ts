// Alias layer that makes backend models selectable from Claude Code's /model.
// Claude Code drops any discovered model id that doesn't match
// /^(claude|anthropic)/i, so every backend id is advertised under a
// `claude-ccf-…` alias and mapped back on the way in.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALIAS_PREFIX,
  buildCatalog,
  isAlias,
  isChatModel,
  modelsResponse,
  sanitize,
  toBackendModel,
} from "../src/catalog.ts";
import { DEFAULT_PROVIDER, type Provider } from "../src/providers.ts";

/** The filter Claude Code applies to gateway-discovered model ids. */
const CLAUDE_FILTER = /^(claude|anthropic)/i;

const OLLAMA_IDS = [
  "qwen2.5:7b",
  "glm-5.2:cloud",
  "deepseek-v4-pro:cloud",
  "kimi-k2.7-code:cloud",
  "richardyoung/qwythos-9b-abliterated:latest",
  "llama2-uncensored:7b",
  "nomic-embed-text:v1.5",
];

function provider(id: string, baseURL = "http://localhost:11434/v1"): Provider {
  return { id, baseURL, apiKey: null };
}

/** A single flat-config backend — the legacy, provider-less alias shape. */
function single(ids: string[]) {
  return buildCatalog([{ provider: provider(DEFAULT_PROVIDER), ids }]);
}

test("every advertised alias survives Claude Code's id filter", () => {
  const catalog = single(OLLAMA_IDS);
  assert.ok(catalog.entries.length > 0);
  for (const e of catalog.entries) {
    assert.match(e.alias, CLAUDE_FILTER, `${e.alias} would be dropped by the picker`);
  }
});

test("aliases round-trip back to the real backend id", () => {
  const catalog = single(OLLAMA_IDS);
  for (const e of catalog.entries) {
    assert.equal(toBackendModel(catalog, e.alias)?.id, e.id);
  }
});

test("embedding models are kept out of the picker", () => {
  assert.equal(isChatModel("nomic-embed-text:v1.5"), false);
  assert.equal(isChatModel("bge-reranker-v2"), false);
  assert.equal(isChatModel("qwen2.5:7b"), true);
  // A chat model that merely contains the substring must survive.
  assert.equal(isChatModel("embedder-chat-9b"), true);

  const catalog = single(OLLAMA_IDS);
  assert.ok(!catalog.entries.some((e) => e.id.includes("nomic-embed-text")));
});

test("the real model name is what the picker renders", () => {
  const catalog = single(["glm-5.2:cloud"]);
  const body = modelsResponse(catalog);
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0]!.display_name, "glm-5.2:cloud");
  assert.equal(body.data[0]!.id, `${ALIAS_PREFIX}glm-5.2-cloud`);
});

test("ids that sanitize alike stay individually addressable", () => {
  const catalog = single(["a:b", "a-b"]);
  const aliases = catalog.entries.map((e) => e.alias);
  assert.equal(new Set(aliases).size, 2, "collision produced a duplicate alias");
  assert.equal(toBackendModel(catalog, aliases[0]!)?.id, "a:b");
  assert.equal(toBackendModel(catalog, aliases[1]!)?.id, "a-b");
});

test("a stale alias still resolves after the model list is re-probed", () => {
  const before = single(["glm-5.2:cloud"]);
  const alias = before.entries[0]!.alias;
  const after = single(["qwen2.5:7b", "glm-5.2:cloud"]);
  assert.equal(toBackendModel(after, alias)?.id, "glm-5.2:cloud");
});

test("Anthropic tier ids fall through to the configured default", () => {
  const catalog = single(OLLAMA_IDS);
  assert.equal(toBackendModel(catalog, "claude-sonnet-4-5-20250929"), null);
  assert.equal(toBackendModel(catalog, undefined), null);
  assert.equal(toBackendModel(catalog, `${ALIAS_PREFIX}model-that-went-away`), null);
});

test("a real backend id typed directly is honored", () => {
  const catalog = single(OLLAMA_IDS);
  assert.equal(toBackendModel(catalog, "qwen2.5:7b")?.id, "qwen2.5:7b");
});

test("sanitize/isAlias basics", () => {
  assert.equal(sanitize("glm-5.2:cloud"), "glm-5.2-cloud");
  assert.equal(sanitize("owner/model:latest"), "owner-model-latest");
  assert.equal(isAlias(`${ALIAS_PREFIX}x`), true);
  assert.equal(isAlias("claude-opus-4"), false);
});

/* ---------------------------- multiple providers -------------------------- */

const MULTI = () =>
  buildCatalog([
    { provider: provider("local", "http://localhost:11434/v1"), ids: ["qwen2.5:7b", "llama3"] },
    { provider: provider("cloud", "https://ollama.com/v1"), ids: ["glm-5.2", "qwen2.5:7b"] },
  ]);

test("several backends appear in one picker, each tagged with its provider", () => {
  const body = modelsResponse(MULTI());
  assert.equal(body.data.length, 4);
  for (const m of body.data) assert.match(m.id, CLAUDE_FILTER);
  assert.ok(body.data.every((m) => /\((local|cloud)\)$/.test(m.display_name)));
});

test("the same model name on two providers stays individually addressable", () => {
  // Both backends serve qwen2.5:7b — picking either must reach the right one.
  const catalog = MULTI();
  const qwens = catalog.entries.filter((e) => e.id === "qwen2.5:7b");
  assert.equal(qwens.length, 2);
  assert.notEqual(qwens[0]!.alias, qwens[1]!.alias);
  for (const q of qwens) {
    assert.equal(toBackendModel(catalog, q.alias)?.provider.id, q.provider.id);
  }
});

test("multi-provider aliases carry the provider id", () => {
  const catalog = MULTI();
  const local = catalog.entries.find((e) => e.provider.id === "local" && e.id === "llama3")!;
  assert.equal(local.alias, `${ALIAS_PREFIX}local-llama3`);
});

test("an alias resolves to the provider that serves it, with its credentials", () => {
  const catalog = buildCatalog([
    { provider: { id: "a", baseURL: "http://a/v1", apiKey: "key-a" }, ids: ["m"] },
    { provider: { id: "b", baseURL: "http://b/v1", apiKey: "key-b" }, ids: ["m"] },
  ]);
  const b = catalog.entries.find((e) => e.provider.id === "b")!;
  const resolved = toBackendModel(catalog, b.alias)!;
  assert.equal(resolved.provider.baseURL, "http://b/v1");
  assert.equal(resolved.provider.apiKey, "key-b");
});

test("a bare model name served by several providers prefers the default", () => {
  const catalog = buildCatalog([
    { provider: provider("other"), ids: ["shared"] },
    { provider: provider(DEFAULT_PROVIDER), ids: ["shared"] },
  ]);
  assert.equal(toBackendModel(catalog, "shared")?.provider.id, DEFAULT_PROVIDER);
});

test("an alias cached before a provider was added still resolves", () => {
  // Upgrading from one backend to several changes the alias shape; a pick the
  // CLI cached under the old shape must not silently stop working.
  const legacyAlias = single(["qwen2.5:7b"]).entries[0]!.alias;
  assert.equal(legacyAlias, `${ALIAS_PREFIX}qwen2.5-7b`);
  const grown = buildCatalog([
    { provider: provider("local"), ids: ["qwen2.5:7b"] },
    { provider: provider("cloud"), ids: ["glm-5.2"] },
  ]);
  assert.equal(toBackendModel(grown, legacyAlias)?.id, "qwen2.5:7b");
});

test("unreachable providers are reported, not silently omitted", () => {
  const catalog = buildCatalog([
    { provider: provider("up"), ids: ["m"] },
    { provider: provider("down"), ids: [] },
  ]);
  assert.deepEqual(catalog.unreachable, ["down"]);
  assert.equal(catalog.entries.length, 1, "a dead backend must not break a live one");
});
