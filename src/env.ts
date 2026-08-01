import type { ProxyConfig } from "./types.ts";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function truthy(v: string | undefined): boolean {
  return v !== undefined && TRUTHY.has(v.trim().toLowerCase());
}

/** Reads + validates the environment flags. Called per-request so test/runtime
 * changes take effect immediately (useful for the test harness). */
export function loadConfig(): ProxyConfig {
  const useOpenAI = truthy(process.env.USE_OPENAI_API);

  const openAIKey = process.env.OPENAI_API_KEY ?? null;
  const openAIModel = process.env.OPENAI_MODEL ?? null;
  const openAIBaseURL = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");

  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? null;
  const anthropicBaseURL = (process.env.ANTHROPIC_REAL_BASE_URL ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "");

  const port = Number(process.env.PROXY_PORT ?? 8787);

  if (useOpenAI) {
    if (!openAIKey) throw new Error("USE_OPENAI_API=1 but OPENAI_API_KEY is not set");
    if (!openAIModel) throw new Error("USE_OPENAI_API=1 but OPENAI_MODEL is not set");
  }

  return { useOpenAI, openAIKey, openAIModel, openAIBaseURL, anthropicKey, anthropicBaseURL, port };
}

/** True only when the proxy itself should intercept (i.e. OpenAI routing on). */
export function isOpenAIRouting(): boolean {
  return loadConfig().useOpenAI;
}