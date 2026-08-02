// Backend model catalog + Claude-Code-compatible aliasing.
//
// Why aliases exist
// -----------------
// Claude Code discovers extra /model entries from an LLM gateway by fetching
// `${ANTHROPIC_BASE_URL}/v1/models?limit=1000` at startup (gated on
// CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, a non-anthropic base URL, and a
// first-party provider). It then applies a hard filter to the ids it gets back:
//
//     data.filter((m) => /^(claude|anthropic)/i.test(m.id))
//
// So a raw Ollama id like `glm-5.2:cloud` is dropped on the floor. To make
// every backend model selectable from `/model`, we advertise each one under a
// `claude-ccf-…` alias and keep the real name in `display_name` (which is what
// the picker actually renders). When the CLI later sends the alias back as
// `body.model`, `toBackendModel()` maps it to the real provider + model.
//
// With several providers configured the alias carries the provider too
// (`claude-ccf-local-qwen2.5-7b`), so one picker spans every backend. A
// single flat OPENAI_* config keeps the original provider-less alias shape.
//
// The catalog is probed lazily and cached briefly so /model hot-swaps and
// newly-pulled models are picked up without restarting the proxy.

import type { ProxyConfig } from "./types.ts";
import { probeModels } from "./setup.ts";
import {
  DEFAULT_PROVIDER,
  isLegacySingle,
  loadProviders,
  type Provider,
} from "./providers.ts";

export const ALIAS_PREFIX = "claude-ccf-";

/** Models that can't serve chat completions and only clutter the picker. */
const NON_CHAT = /(?:^|[-_/])(?:embed|embedding|rerank|reranker)(?:$|[-_:/.])/i;

export interface CatalogEntry {
  /** Real backend id, e.g. `glm-5.2:cloud`. */
  id: string;
  /** Alias advertised to Claude Code, e.g. `claude-ccf-cloud-glm-5.2`. */
  alias: string;
  /** Which backend serves it. */
  provider: Provider;
}

export interface Catalog {
  entries: CatalogEntry[];
  byAlias: Map<string, CatalogEntry>;
  /** Providers that were probed, whether or not they answered. */
  providers: Provider[];
  /** Provider ids whose /models probe came back empty. */
  unreachable: string[];
}

const EMPTY: Catalog = { entries: [], byAlias: new Map(), providers: [], unreachable: [] };

/** Strip everything Claude Code's model ids can't carry, keeping it readable. */
export function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** True when `id` looks like one of our advertised aliases. */
export function isAlias(id: string): boolean {
  return id.toLowerCase().startsWith(ALIAS_PREFIX);
}

/** Should this backend model show up in the /model picker? */
export function isChatModel(id: string): boolean {
  return !NON_CHAT.test(id);
}

/** Alias for one model on one provider. Provider-less in the legacy case so
 * aliases Claude Code already cached keep resolving. */
export function aliasFor(providerId: string, model: string, legacy: boolean): string {
  const stem = legacy ? sanitize(model) : `${sanitize(providerId)}-${sanitize(model)}`;
  return `${ALIAS_PREFIX}${stem}`;
}

/** Build the alias table across every provider's model list. */
export function buildCatalog(
  listings: Array<{ provider: Provider; ids: string[] }>,
): Catalog {
  const providers = listings.map((l) => l.provider);
  const legacy = isLegacySingle(providers);
  const entries: CatalogEntry[] = [];
  const byAlias = new Map<string, CatalogEntry>();
  const taken = new Set<string>();

  for (const { provider, ids } of listings) {
    for (const id of ids.filter(isChatModel)) {
      const base = aliasFor(provider.id, id, legacy);
      let alias = base;
      // Two distinct ids can sanitize to the same string (`a:b` and `a-b`), and
      // two providers can serve the same model name. Keep both addressable
      // rather than silently dropping one.
      for (let n = 2; taken.has(alias); n++) alias = `${base}-${n}`;
      taken.add(alias);
      const entry: CatalogEntry = { id, alias, provider };
      entries.push(entry);
      byAlias.set(alias, entry);
    }
  }

  return {
    entries,
    byAlias,
    providers,
    unreachable: listings.filter((l) => !l.ids.length).map((l) => l.provider.id),
  };
}

/* ------------------------------- caching ---------------------------------- */

/** A complete answer is stable; hold it. */
const TTL_OK_MS = 60_000;
/** A partial answer means a backend was slow or down. Retry soon — Claude Code
 * fetches the picker once at startup, so a provider that silently drops out
 * stays missing from /model for the whole session. */
const TTL_PARTIAL_MS = 5_000;

/** Request-path budget. Claude Code aborts its gateway discovery fetch after
 * 3s, so answering /v1/models has to fit inside that. */
export const PROBE_TIMEOUT_REQUEST_MS = 2_500;
/** Startup budget. Nothing is waiting on us, and a remote backend's first
 * request pays for DNS + TLS before it can answer. */
export const PROBE_TIMEOUT_WARM_MS = 15_000;

let cached: Catalog | null = null;
let cachedAt = 0;
let cachedFor = "";
let cachedTtl = TTL_OK_MS;

/** Reset the memo — for tests, and after a backend switch. */
export function clearCatalogCache(): void {
  cached = null;
  cachedAt = 0;
  cachedFor = "";
  cachedTtl = TTL_OK_MS;
}

function cacheKey(providers: Provider[]): string {
  return providers.map((p) => `${p.id}|${p.baseURL}|${p.apiKey ?? ""}`).join("\n");
}

/** Probe one provider's /models. Never throws — an unreachable backend
 * contributes nothing instead of failing the whole catalog. */
async function listModels(p: Provider, timeoutMs: number): Promise<string[]> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (p.apiKey) headers.authorization = `Bearer ${p.apiKey}`;
  const ids = await probeModels(
    p.baseURL,
    (url, init) =>
      fetch(url, {
        ...init,
        headers: { ...headers, ...((init?.headers as Record<string, string>) ?? {}) },
      } as RequestInit),
    timeoutMs,
  );
  return ids.sort((a, b) => a.localeCompare(b));
}

async function probeAll(providers: Provider[], timeoutMs: number): Promise<Catalog | null> {
  const listings = await Promise.all(
    providers.map(async (provider) => ({ provider, ids: await listModels(provider, timeoutMs) })),
  );

  // Nothing answered: don't cache the outage at all, so a backend coming back
  // up is picked up on the very next request.
  if (listings.every((l) => !l.ids.length)) return null;

  const catalog = buildCatalog(listings);
  cached = catalog;
  cachedAt = Date.now();
  cachedFor = cacheKey(providers);
  cachedTtl = catalog.unreachable.length ? TTL_PARTIAL_MS : TTL_OK_MS;
  return catalog;
}

/** Probe every configured provider (in parallel) and return the alias table. */
export async function getCatalog(cfg: ProxyConfig): Promise<Catalog> {
  const { providers } = loadProviders(cfg);
  if (!providers.length) return EMPTY;

  const key = cacheKey(providers);
  if (cached && cachedFor === key && Date.now() - cachedAt < cachedTtl) return cached;

  const catalog = await probeAll(providers, PROBE_TIMEOUT_REQUEST_MS);
  return catalog ?? { ...EMPTY, providers, unreachable: providers.map((p) => p.id) };
}

/** Fill the cache before anything asks, with a budget the request path can't
 * afford. Called at server start so Claude Code's one-shot discovery fetch
 * gets a complete list instead of whatever answered within 2.5s. */
export async function warmCatalog(cfg: ProxyConfig): Promise<Catalog | null> {
  const { providers } = loadProviders(cfg);
  if (!providers.length) return null;
  return probeAll(providers, PROBE_TIMEOUT_WARM_MS);
}

/** Map whatever the CLI put in `body.model` onto a real provider + model.
 *
 * Returns null when the incoming model is an Anthropic tier id (the normal
 * case — the caller then falls back to the default provider's model). */
export function toBackendModel(catalog: Catalog, bodyModel: string | undefined): CatalogEntry | null {
  if (!bodyModel) return null;

  // 1. An alias we advertised via /v1/models.
  const direct = catalog.byAlias.get(bodyModel);
  if (direct) return direct;

  // 2. An alias from a previous catalog (the model list changed under us, or
  //    the config gained a provider so aliases grew a prefix). Match on the
  //    sanitized tail so a cached pick still lands.
  if (isAlias(bodyModel)) {
    const want = bodyModel.slice(ALIAS_PREFIX.length).toLowerCase();
    for (const e of catalog.entries) {
      const withProvider = `${sanitize(e.provider.id)}-${sanitize(e.id)}`.toLowerCase();
      if (withProvider === want || sanitize(e.id).toLowerCase() === want) return e;
    }
    return null;
  }

  // 3. A real backend id typed directly (`/model glm-5.2:cloud`). Prefer the
  //    default provider when more than one serves that name.
  const matches = catalog.entries.filter((e) => e.id === bodyModel);
  return matches.find((e) => e.provider.id === DEFAULT_PROVIDER) ?? matches[0] ?? null;
}

/** The `/v1/models` payload Claude Code's gateway discovery expects. */
export function modelsResponse(catalog: Catalog): {
  object: "list";
  data: Array<{ id: string; object: "model"; display_name: string; created: number; owned_by: string }>;
  has_more: false;
} {
  const legacy = isLegacySingle(catalog.providers);
  return {
    object: "list",
    data: catalog.entries.map((e) => ({
      id: e.alias,
      object: "model" as const,
      // What the /model picker actually renders. With several backends the
      // provider has to be visible, or two identically-named models are
      // indistinguishable in the list.
      display_name: legacy ? e.id : `${e.id}  (${e.provider.id})`,
      created: 0,
      owned_by: e.provider.id,
    })),
    has_more: false,
  };
}
