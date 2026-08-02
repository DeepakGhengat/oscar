import { loadEnvFile } from "./envfile.ts";
import type { ProxyConfig } from "./types.ts";

loadEnvFile();

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function truthy(v: string | undefined): boolean {
  return v !== undefined && TRUTHY.has(v.trim().toLowerCase());
}

const ANTHROPIC_DEFAULT = "https://api.anthropic.com";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

/** True when `url` is this proxy — i.e. forwarding to it would loop. */
export function pointsAtSelf(url: string, port: number): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (!LOOPBACK.has(host)) return false;
    const urlPort = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    return urlPort === port;
  } catch {
    return false;
  }
}

/** First candidate that isn't us, else the real Anthropic endpoint. */
export function resolveAnthropicBaseURL(
  candidates: Array<string | undefined>,
  port: number,
): string {
  for (const raw of candidates) {
    if (!raw) continue;
    const url = raw.replace(/\/$/, "");
    if (pointsAtSelf(url, port)) continue;
    return url;
  }
  return ANTHROPIC_DEFAULT;
}

/** Reads + validates the environment flags. Called per-request so test/runtime
 * changes take effect immediately (useful for the test harness). */
export function loadConfig(): ProxyConfig {
  const useOpenAI = truthy(process.env.USE_OPENAI_API);

  const openAIKey = process.env.OPENAI_API_KEY ?? null;
  const openAIModel = process.env.OPENAI_MODEL ?? null;
  const openAIBaseURL = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");

  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? null;
  const port = Number(process.env.PROXY_PORT ?? 8787);

  // ANTHROPIC_BASE_URL points at *this proxy* while claude is running. If it
  // leaks into the proxy's own environment (a stale .env entry, an exported
  // shell var) passthrough would forward to ourselves and spin. Prefer the
  // explicit REAL url, and refuse any candidate that resolves back to us.
  const anthropicBaseURL = resolveAnthropicBaseURL(
    [process.env.ANTHROPIC_REAL_BASE_URL, process.env.ANTHROPIC_BASE_URL],
    port,
  );

  // Claude Code sizes max_tokens for a 200k-context Claude model. Backends
  // with a smaller ceiling reject the request or truncate mid-answer, so allow
  // an explicit cap. Unset (or non-positive) means "don't clamp".
  const rawCap = Number(process.env.CCF_MAX_OUTPUT_TOKENS ?? "");
  const maxOutputTokens = Number.isFinite(rawCap) && rawCap > 0 ? rawCap : null;

  if (useOpenAI) {
    if (!openAIKey) throw new Error("USE_OPENAI_API=1 but OPENAI_API_KEY is not set");
    if (!openAIModel) throw new Error("USE_OPENAI_API=1 but OPENAI_MODEL is not set");
  }

  return {
    useOpenAI,
    openAIKey,
    openAIModel,
    openAIBaseURL,
    maxOutputTokens,
    anthropicKey,
    anthropicBaseURL,
    port,
  };
}

/** True only when the proxy itself should intercept (i.e. OpenAI routing on). */
export function isOpenAIRouting(): boolean {
  return loadConfig().useOpenAI;
}