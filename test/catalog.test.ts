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

test("every advertised alias survives Claude Code's id filter", () => {
  const catalog = buildCatalog(OLLAMA_IDS);
  assert.ok(catalog.entries.length > 0);
  for (const e of catalog.entries) {
    assert.match(e.alias, CLAUDE_FILTER, `${e.alias} would be dropped by the picker`);
  }
});

test("aliases round-trip back to the real backend id", () => {
  const catalog = buildCatalog(OLLAMA_IDS);
  for (const e of catalog.entries) {
    assert.equal(toBackendModel(catalog, e.alias), e.id);
  }
});

test("embedding models are kept out of the picker", () => {
  assert.equal(isChatModel("nomic-embed-text:v1.5"), false);
  assert.equal(isChatModel("bge-reranker-v2"), false);
  assert.equal(isChatModel("qwen2.5:7b"), true);
  // A chat model that merely contains the substring must survive.
  assert.equal(isChatModel("embedder-chat-9b"), true);

  const catalog = buildCatalog(OLLAMA_IDS);
  assert.ok(!catalog.entries.some((e) => e.id.includes("nomic-embed-text")));
});

test("the real model name is what the picker renders", () => {
  const catalog = buildCatalog(["glm-5.2:cloud"]);
  const body = modelsResponse(catalog);
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0]!.display_name, "glm-5.2:cloud");
  assert.equal(body.data[0]!.id, `${ALIAS_PREFIX}glm-5.2-cloud`);
});

test("ids that sanitize alike stay individually addressable", () => {
  const catalog = buildCatalog(["a:b", "a-b"]);
  const aliases = catalog.entries.map((e) => e.alias);
  assert.equal(new Set(aliases).size, 2, "collision produced a duplicate alias");
  assert.equal(toBackendModel(catalog, aliases[0]!), "a:b");
  assert.equal(toBackendModel(catalog, aliases[1]!), "a-b");
});

test("a stale alias still resolves after the model list is re-probed", () => {
  // Same backend model, catalog rebuilt with different neighbours: the alias
  // the CLI cached earlier must still map home.
  const before = buildCatalog(["glm-5.2:cloud"]);
  const alias = before.entries[0]!.alias;
  const after = buildCatalog(["qwen2.5:7b", "glm-5.2:cloud"]);
  assert.equal(toBackendModel(after, alias), "glm-5.2:cloud");
});

test("Anthropic tier ids fall through to OPENAI_MODEL", () => {
  const catalog = buildCatalog(OLLAMA_IDS);
  assert.equal(toBackendModel(catalog, "claude-sonnet-4-5-20250929"), null);
  assert.equal(toBackendModel(catalog, undefined), null);
  // An alias for a model the backend no longer serves must not be invented.
  assert.equal(toBackendModel(catalog, `${ALIAS_PREFIX}model-that-went-away`), null);
});

test("a real backend id typed directly is honored", () => {
  const catalog = buildCatalog(OLLAMA_IDS);
  assert.equal(toBackendModel(catalog, "qwen2.5:7b"), "qwen2.5:7b");
});

test("sanitize/isAlias basics", () => {
  assert.equal(sanitize("glm-5.2:cloud"), "glm-5.2-cloud");
  assert.equal(sanitize("owner/model:latest"), "owner-model-latest");
  assert.equal(isAlias(`${ALIAS_PREFIX}x`), true);
  assert.equal(isAlias("claude-opus-4"), false);
});
