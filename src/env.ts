import { loadEnvFile } from "./envfile.ts";
import type { ProxyConfig, UpstreamAuthMode } from "./types.ts";

loadEnvFile();

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function truthy(v: string | undefined): boolean {
  return v !== undefined && TRUTHY.has(v.trim().toLowerCase());
}

const UPSTREAM_DEFAULT = "https://api.anthropic.com";
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
export function resolveUpstreamBaseURL(
  candidates: Array<string | undefined>,
  port: number,
): string {
  for (const raw of candidates) {
    if (!raw) continue;
    const url = raw.replace(/\/$/, "");
    if (pointsAtSelf(url, port)) continue;
    return url;
  }
  return UPSTREAM_DEFAULT;
}

/** How passthrough should authenticate.
 *
 * `subscription` means the CLI is signed in with an account — a Pro/Max/Team
 * login or enterprise SSO — and carries its own short-lived OAuth credentials
 * per request. There is no key for us to hold, and anything we add to the auth
 * headers can only break the request, so the proxy stays out of the way.
 *
 * Explicit `OSCAR_AUTH` wins. Otherwise: no API key configured implies the CLI
 * is signing itself in, because passthrough with neither is not a thing. */
export function resolveUpstreamAuth(
  declared: string | undefined,
  apiKey: string | null,
): UpstreamAuthMode {
  const v = (declared ?? "").trim().toLowerCase();
  if (v === "subscription" || v === "oauth" || v === "sso" || v === "login") return "subscription";
  if (v === "api-key" || v === "apikey" || v === "key") return "api-key";
  return apiKey ? "api-key" : "subscription";
}

/** Reads + validates the environment flags. Called per-request so test/runtime
 * changes take effect immediately (useful for the test harness). */
export function loadConfig(): ProxyConfig {
  const useOpenAI = truthy(process.env.USE_OPENAI_API);

  const openAIKey = process.env.OPENAI_API_KEY ?? null;
  const openAIModel = process.env.OPENAI_MODEL ?? null;
  const openAIBaseURL = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");

  const upstreamKey = process.env.ANTHROPIC_API_KEY ?? null;
  const port = Number(process.env.PROXY_PORT ?? 8787);

  // ANTHROPIC_BASE_URL points at *this proxy* while the CLI is running. If it
  // leaks into the proxy's own environment (a stale .env entry, an exported
  // shell var) passthrough would forward to ourselves and spin. Prefer the
  // explicit REAL url, and refuse any candidate that resolves back to us.
  const upstreamBaseURL = resolveUpstreamBaseURL(
    [process.env.OSCAR_UPSTREAM_BASE_URL, process.env.ANTHROPIC_BASE_URL],
    port,
  );

  // The CLI sizes max_tokens for a 200k-context frontier model. Backends
  // with a smaller ceiling reject the request or truncate mid-answer, so allow
  // an explicit cap. Unset (or non-positive) means "don't clamp".
  const rawCap = Number(process.env.OSCAR_MAX_OUTPUT_TOKENS ?? "");
  const maxOutputTokens = Number.isFinite(rawCap) && rawCap > 0 ? rawCap : null;

  if (useOpenAI) {
    if (!openAIKey) throw new Error("USE_OPENAI_API=1 but OPENAI_API_KEY is not set");
    if (!openAIModel) throw new Error("USE_OPENAI_API=1 but OPENAI_MODEL is not set");
  }

  // Hybrid needs the Anthropic side configured *on purpose*. Inferring it from
  // an absent key would switch it on for every plain OpenAI setup, and the
  // CLI's opening model is an Anthropic tier — so a session would start by
  // calling a vendor the user never signed in to.
  const declaredAuth = (process.env.OSCAR_AUTH ?? "").trim().toLowerCase();
  const anthropicOnPurpose =
    ["subscription", "oauth", "sso", "login"].includes(declaredAuth) || Boolean(upstreamKey);

  return {
    useOpenAI,
    openAIKey,
    openAIModel,
    openAIBaseURL,
    maxOutputTokens,
    upstreamKey,
    upstreamBaseURL,
    upstreamAuth: resolveUpstreamAuth(process.env.OSCAR_AUTH, upstreamKey),
    hybrid: useOpenAI && anthropicOnPurpose,
    port,
  };
}

/** True only when the proxy itself should intercept (i.e. OpenAI routing on). */
export function isOpenAIRouting(): boolean {
  return loadConfig().useOpenAI;
}