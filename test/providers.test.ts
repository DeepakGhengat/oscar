// providers.json parsing, the flat-.env fallback, and token-ceiling precedence.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PROVIDER,
  isLegacySingle,
  loadProviders,
  parseProviders,
  providersFilePath,
  resolveMaxOutputTokens,
  type Provider,
} from "../src/providers.ts";
import type { ProxyConfig } from "../src/types.ts";

let dir: string;
let prevConfig: string | undefined;

const cfg: ProxyConfig = {
  useOpenAI: true,
  openAIKey: "sk-env",
  openAIModel: "qwen2.5:7b",
  openAIBaseURL: "http://localhost:11434/v1",
  maxOutputTokens: null,
  upstreamKey: null,
  upstreamBaseURL: "https://api.anthropic.com",
  port: 8787,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oscar-prov-"));
  prevConfig = process.env.OSCAR_CONFIG;
  process.env.OSCAR_CONFIG = dir;
});

afterEach(() => {
  if (prevConfig === undefined) delete process.env.OSCAR_CONFIG;
  else process.env.OSCAR_CONFIG = prevConfig;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* cosmetic */
  }
});

function writeProviders(doc: unknown): void {
  writeFileSync(providersFilePath(), typeof doc === "string" ? doc : JSON.stringify(doc));
}

/* --------------------------------- parsing -------------------------------- */

test("a well-formed document yields every provider", () => {
  const { providers, errors } = parseProviders(
    JSON.stringify({
      providers: {
        local: { baseURL: "http://localhost:11434/v1", apiKey: "ollama" },
        cloud: { baseURL: "https://ollama.com/v1", apiKey: "real-key" },
      },
    }),
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(providers.map((p) => p.id), ["local", "cloud"]);
  assert.equal(providers[1]!.apiKey, "real-key");
});

test("trailing slashes are stripped from provider base URLs", () => {
  const { providers } = parseProviders(
    JSON.stringify({ providers: { a: { baseURL: "http://h/v1/" } } }),
  );
  assert.equal(providers[0]!.baseURL, "http://h/v1");
});

test("a provider with no key is allowed", () => {
  const { providers } = parseProviders(JSON.stringify({ providers: { a: { baseURL: "http://h/v1" } } }));
  assert.equal(providers[0]!.apiKey, null);
});

test("one broken provider does not discard the others", () => {
  const { providers, errors } = parseProviders(
    JSON.stringify({
      providers: {
        good: { baseURL: "http://h/v1" },
        broken: { apiKey: "no-base-url" },
        "bad id!": { baseURL: "http://h/v1" },
      },
    }),
  );
  assert.deepEqual(providers.map((p) => p.id), ["good"]);
  assert.equal(errors.length, 2);
});

test("invalid JSON is reported, not thrown", () => {
  const { providers, errors } = parseProviders("{not json");
  assert.deepEqual(providers, []);
  assert.match(errors[0]!, /not valid JSON/);
});

test("a document without a providers object is reported", () => {
  for (const doc of ["{}", '{"providers":[]}', '{"providers":"nope"}']) {
    const { providers, errors } = parseProviders(doc);
    assert.deepEqual(providers, []);
    assert.ok(errors.length > 0);
  }
});

test("per-model and per-provider ceilings are parsed, junk is ignored", () => {
  const { providers } = parseProviders(
    JSON.stringify({
      providers: {
        a: {
          baseURL: "http://h/v1",
          maxOutputTokens: 8192,
          models: { good: { maxOutputTokens: 4096 }, zero: { maxOutputTokens: 0 }, bad: { maxOutputTokens: "x" } },
        },
      },
    }),
  );
  assert.equal(providers[0]!.maxOutputTokens, 8192);
  assert.deepEqual(Object.keys(providers[0]!.models ?? {}), ["good"]);
});

/* -------------------------------- loading --------------------------------- */

test("with no providers.json the flat .env config is used", () => {
  const { providers } = loadProviders(cfg);
  assert.equal(providers.length, 1);
  assert.equal(providers[0]!.id, DEFAULT_PROVIDER);
  assert.equal(providers[0]!.baseURL, "http://localhost:11434/v1");
  assert.equal(providers[0]!.apiKey, "sk-env");
});

test("providers.json takes over when present", () => {
  writeProviders({ providers: { cloud: { baseURL: "https://ollama.com/v1", apiKey: "k" } } });
  const { providers } = loadProviders(cfg);
  assert.deepEqual(providers.map((p) => p.id), ["cloud"]);
});

test("an unusable providers.json falls back to .env rather than breaking", () => {
  // A typo in a config file must not take the proxy down.
  writeProviders("{ broken");
  const { providers, errors } = loadProviders(cfg);
  assert.equal(providers[0]!.id, DEFAULT_PROVIDER);
  assert.ok(errors.length > 0, "the problem must still be reported");
});

test("the global clamp becomes the default provider's ceiling", () => {
  const { providers } = loadProviders({ ...cfg, maxOutputTokens: 2048 });
  assert.equal(providers[0]!.maxOutputTokens, 2048);
});

/* ------------------------------ legacy shape ------------------------------ */

test("only a lone default provider counts as the legacy shape", () => {
  const p = (id: string): Provider => ({ id, baseURL: "http://h/v1", apiKey: null });
  assert.equal(isLegacySingle([p(DEFAULT_PROVIDER)]), true);
  assert.equal(isLegacySingle([p("local")]), false);
  assert.equal(isLegacySingle([p(DEFAULT_PROVIDER), p("cloud")]), false);
  assert.equal(isLegacySingle([]), false);
});

/* --------------------------- ceiling precedence --------------------------- */

test("model ceiling beats provider ceiling beats global", () => {
  const p: Provider = {
    id: "a",
    baseURL: "http://h/v1",
    apiKey: null,
    maxOutputTokens: 8192,
    models: { small: { maxOutputTokens: 512 } },
  };
  assert.equal(resolveMaxOutputTokens(p, "small", 32000), 512);
  assert.equal(resolveMaxOutputTokens(p, "other", 32000), 8192);

  const bare: Provider = { id: "b", baseURL: "http://h/v1", apiKey: null };
  assert.equal(resolveMaxOutputTokens(bare, "any", 32000), 32000);
  assert.equal(resolveMaxOutputTokens(bare, "any", null), null);
});

/* -------------------------------- file path ------------------------------- */

test("providers.json sits beside the .env it belongs to", () => {
  assert.equal(providersFilePath(), join(dir, "providers.json"));
});
