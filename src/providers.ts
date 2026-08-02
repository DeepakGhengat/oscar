// Multiple backends at once.
//
// A single OPENAI_BASE_URL means switching from local Ollama to DeepSeek is a
// re-run of the setup wizard. With a providers.json beside the .env, every
// configured backend is probed together and they all appear in one /model
// picker, keyed by provider:
//
//   {
//     "providers": {
//       "local":  { "baseURL": "http://localhost:11434/v1", "apiKey": "ollama" },
//       "cloud":  { "baseURL": "https://ollama.com/v1",     "apiKey": "..." },
//       "deep":   { "baseURL": "https://api.deepseek.com/v1", "apiKey": "...",
//                   "maxOutputTokens": 8192,
//                   "models": { "deepseek-chat": { "maxOutputTokens": 4096 } } }
//     }
//   }
//
// With no providers.json the flat OPENAI_* env is used unchanged, as a single
// provider named "default" — existing setups keep working, and keep their
// existing alias shape.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProxyConfig } from "./types.ts";

/** The synthetic provider id used for a flat, single-backend .env config. */
export const DEFAULT_PROVIDER = "default";

export interface ProviderModelOptions {
  maxOutputTokens?: number;
}

export interface Provider {
  id: string;
  baseURL: string;
  apiKey: string | null;
  /** Ceiling for this backend, overriding the global one. */
  maxOutputTokens?: number;
  /** Per-model overrides, most specific wins. */
  models?: Record<string, ProviderModelOptions>;
}

/** Where providers.json lives: beside the .env the rest of the tool uses. */
export function providersFilePath(): string {
  const dir = process.env.OSCAR_CONFIG;
  return dir ? join(resolve(dir), "providers.json") : resolve("providers.json");
}

/** Provider ids must survive alias sanitisation and stay readable. */
function validId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}

/** Parse a providers.json document. Invalid entries are skipped, not fatal —
 * one bad block should not take the whole proxy down. */
export function parseProviders(raw: string): { providers: Provider[]; errors: string[] } {
  const errors: string[] = [];
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return { providers: [], errors: [`providers.json is not valid JSON: ${(err as Error).message}`] };
  }

  const table = (doc as { providers?: unknown })?.providers;
  if (!table || typeof table !== "object" || Array.isArray(table)) {
    return { providers: [], errors: ["providers.json needs a top-level \"providers\" object"] };
  }

  const providers: Provider[] = [];
  for (const [id, value] of Object.entries(table as Record<string, unknown>)) {
    if (!validId(id)) {
      errors.push(`provider id ${JSON.stringify(id)} must be alphanumeric with . _ -`);
      continue;
    }
    const v = value as Partial<Provider> | null;
    const baseURL = typeof v?.baseURL === "string" ? v.baseURL.replace(/\/$/, "") : "";
    if (!baseURL) {
      errors.push(`provider ${JSON.stringify(id)} has no baseURL`);
      continue;
    }
    const p: Provider = {
      id,
      baseURL,
      apiKey: typeof v?.apiKey === "string" && v.apiKey ? v.apiKey : null,
    };
    if (typeof v?.maxOutputTokens === "number" && v.maxOutputTokens > 0) {
      p.maxOutputTokens = v.maxOutputTokens;
    }
    if (v?.models && typeof v.models === "object") {
      const models: Record<string, ProviderModelOptions> = {};
      for (const [m, opts] of Object.entries(v.models as Record<string, ProviderModelOptions>)) {
        const cap = opts?.maxOutputTokens;
        if (typeof cap === "number" && cap > 0) models[m] = { maxOutputTokens: cap };
      }
      if (Object.keys(models).length) p.models = models;
    }
    providers.push(p);
  }

  if (!providers.length && !errors.length) errors.push("providers.json defines no usable providers");
  return { providers, errors };
}

/** Resolve the active provider list: providers.json when present and usable,
 * otherwise the flat OPENAI_* config as a single "default" provider. */
export function loadProviders(cfg: ProxyConfig): { providers: Provider[]; errors: string[] } {
  const file = providersFilePath();
  if (existsSync(file)) {
    try {
      const parsed = parseProviders(readFileSync(file, "utf8"));
      if (parsed.providers.length) return parsed;
      return { providers: [fromEnv(cfg)], errors: parsed.errors };
    } catch (err) {
      return { providers: [fromEnv(cfg)], errors: [`could not read ${file}: ${(err as Error).message}`] };
    }
  }
  return { providers: [fromEnv(cfg)], errors: [] };
}

function fromEnv(cfg: ProxyConfig): Provider {
  const p: Provider = {
    id: DEFAULT_PROVIDER,
    baseURL: cfg.openAIBaseURL,
    apiKey: cfg.openAIKey,
  };
  if (cfg.maxOutputTokens) p.maxOutputTokens = cfg.maxOutputTokens;
  return p;
}

/** True when aliases should stay in their original, provider-less form —
 * i.e. nothing multi-provider is configured, so existing aliases keep working. */
export function isLegacySingle(providers: Provider[]): boolean {
  return providers.length === 1 && providers[0]!.id === DEFAULT_PROVIDER;
}

/** Output-token ceiling for a model on a provider: model → provider → global. */
export function resolveMaxOutputTokens(
  provider: Provider,
  model: string,
  globalCap: number | null,
): number | null {
  return provider.models?.[model]?.maxOutputTokens ?? provider.maxOutputTokens ?? globalCap ?? null;
}
