// Interactive setup wizard for claude-code-free.
// Pure helpers are exported for testing; main() runs the interactive loop.

export type ProviderId =
  | "openai" | "deepseek" | "ollama" | "lmstudio" | "vllm" | "custom" | "passthrough";

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  baseURL: string | null;
  defaultModel: string | null;
  keyHint: string | null;
  kind: "cloud" | "local" | "custom" | "passthrough";
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "openai",      label: "OpenAI",                baseURL: "https://api.openai.com/v1",  defaultModel: "gpt-4o-mini", keyHint: null,         kind: "cloud" },
  { id: "deepseek",    label: "DeepSeek",              baseURL: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat", keyHint: null,       kind: "cloud" },
  { id: "ollama",      label: "Ollama (local)",        baseURL: "http://localhost:11434/v1",   defaultModel: "llama3",      keyHint: "ollama",     kind: "local" },
  { id: "lmstudio",    label: "LM Studio (local)",     baseURL: "http://localhost:1234/v1",    defaultModel: null,          keyHint: "lm-studio",  kind: "local" },
  { id: "vllm",        label: "vLLM (local)",          baseURL: "http://localhost:8000/v1",    defaultModel: null,          keyHint: "vllm",       kind: "local" },
  { id: "custom",      label: "Custom OpenAI-compatible", baseURL: null,                       defaultModel: null,          keyHint: null,         kind: "custom" },
  { id: "passthrough", label: "Passthrough to Anthropic", baseURL: null,                        defaultModel: null,          keyHint: null,         kind: "passthrough" },
];

export interface SetupConfig {
  useOpenAI: boolean;
  openAIKey: string | null;
  openAIModel: string | null;
  openAIBaseURL: string | null;
  anthropicKey: string | null;
  port: number;
}

/** Serialize a SetupConfig to .env text. */
export function formatEnv(cfg: SetupConfig): string {
  const lines: string[] = [];
  lines.push(`# claude-code-free config — written by src/setup.ts`);
  lines.push(`PROXY_PORT=${cfg.port}`);
  if (cfg.useOpenAI) {
    lines.push(`USE_OPENAI_API=1`);
    lines.push(`OPENAI_API_KEY=${cfg.openAIKey ?? ""}`);
    lines.push(`OPENAI_MODEL=${cfg.openAIModel ?? ""}`);
    lines.push(`OPENAI_BASE_URL=${cfg.openAIBaseURL ?? ""}`);
  }
  if (cfg.anthropicKey) {
    lines.push(`ANTHROPIC_API_KEY=${cfg.anthropicKey}`);
  }
  return lines.join("\n") + "\n";
}

/** Probe an OpenAI-compatible /models endpoint. Returns [] on any failure/timeout. */
export async function probeModels(
  baseURL: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  try {
    const res = await fetchImpl(`${baseURL.replace(/\/$/, "")}/models`, {
      signal: AbortSignal.timeout(2000),
      headers: { "content-type": "application/json" },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    if (!Array.isArray(json.data)) return [];
    const ids: string[] = [];
    for (const m of json.data) if (typeof m?.id === "string") ids.push(m.id);
    return ids;
  } catch {
    return [];
  }
}

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { banner, box, c, createQuestion, select, type SelectOption } from "./ui.ts";

/** Close readline without triggering the libuv assertion on piped stdin (Windows). */
function closeRl(rl: { close: () => void; pause?: () => void }): void {
  if (!process.stdin.isTTY) {
    try { process.stdin.unref(); } catch {}
    return;
  }
  try { rl.close(); } catch {}
}

async function ask(rl: ReturnType<typeof createInterface>, q: string, fallback?: string): Promise<string> {
  const askFn = createQuestion(rl);
  const prompt = fallback !== undefined
    ? `${c.bold}${q}${c.reset} [${c.gray}${fallback}${c.reset}]: `
    : `${c.bold}${q}${c.reset}: `;
  const answer = (await askFn(prompt)).trim();
  return answer.length ? answer : (fallback ?? "");
}

async function askRequired(rl: ReturnType<typeof createInterface>, q: string): Promise<string> {
  const askFn = createQuestion(rl);
  for (;;) {
    const a = (await askFn(`${c.bold}${q}${c.reset}: `)).trim();
    if (a) return a;
    console.log(`${c.red}  (required, try again)${c.reset}`);
  }
}

export async function main(): Promise<void> {
  const rl = createInterface({ input, output });
  console.log(banner("claude-code-free setup", "Pick a backend, probe its models, write .env"));

  const providerOptions: SelectOption[] = PROVIDER_PRESETS.map((p) => ({
    label: p.label,
    description: p.kind === "local" ? "local" : p.kind,
  }));
  const idx = await select(rl, providerOptions, "Choose an LLM provider");
  const preset = PROVIDER_PRESETS[idx]!;

  const port = Number(await ask(rl, "Proxy port", "8787")) || 8787;

  let useOpenAI = false;
  let openAIKey: string | null = null;
  let openAIModel: string | null = null;
  let openAIBaseURL: string | null = null;
  let anthropicKey: string | null = null;

  if (preset.kind === "passthrough") {
    anthropicKey = await askRequired(rl, "Anthropic API key");
  } else {
    useOpenAI = true;
    openAIBaseURL = preset.baseURL
      ? await ask(rl, "Base URL", preset.baseURL)
      : await askRequired(rl, "Base URL (OpenAI-compatible)");

    // Collect the API key first so we can probe authenticated /models endpoints
    // (Ollama Cloud, OpenAI, DeepSeek all require it to list models).
    openAIKey = preset.keyHint
      ? (await ask(rl, "API key (local servers usually ignore this)", preset.keyHint) || preset.keyHint)
      : await askRequired(rl, "API key");

    // Model selection — probe the live backend with the key, for any provider.
    console.log(`${c.dim}Probing ${openAIBaseURL}/models ...${c.reset}`);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (openAIKey) headers.authorization = `Bearer ${openAIKey}`;
    const models = await probeModels(openAIBaseURL, (url, init) =>
      fetch(url, { ...init, headers: { ...headers, ...((init?.headers as Record<string, string>) ?? {}) } } as RequestInit),
    );
    models.sort((a, b) => a.localeCompare(b));
    if (models.length) {
      const modelOpts: SelectOption[] = models.map((m) => ({ label: m }));
      modelOpts.push({ label: `${c.gray}Type manually${c.reset}` });
      const choice = await select(rl, modelOpts, "Pick a model");
      openAIModel = choice < models.length ? models[choice]! : await askRequired(rl, "Model name");
    } else {
      console.log(`${c.yellow}  (could not reach ${openAIBaseURL}/models — enter the model name manually)${c.reset}`);
      openAIModel = preset.defaultModel
        ? await ask(rl, "Model name", preset.defaultModel)
        : await askRequired(rl, "Model name");
    }
  }

  const cfg: SetupConfig = { useOpenAI, openAIKey, openAIModel, openAIBaseURL, anthropicKey, port };

  const summary = useOpenAI
    ? `provider:  ${preset.label}\nbase URL:  ${openAIBaseURL}\nmodel:     ${openAIModel}\nkey:       ${openAIKey ? openAIKey.slice(0, 4) + "..." : "(none)"}\nport:      ${port}`
    : `provider:      ${preset.label}\nanthropic key: ${anthropicKey ? anthropicKey.slice(0, 4) + "..." : "(none)"}\nport:          ${port}`;
  console.log(`\n${box(summary)}\n`);

  const write = (await ask(rl, "Write .env?", "Y")).toLowerCase();
  if (write.startsWith("y") || write === "") {
    // Global install: config lives at $CLAUDE_CODE_FREE_CONFIG (set by the
    // bin launcher, typically ~/.claude-code-free/.env). Local dev: write to
    // the project root .env.
    const dir = process.env.CLAUDE_CODE_FREE_CONFIG;
    const envPath = dir ? resolve(dir, ".env") : resolve(".env");
    if (dir) mkdirSync(dir, { recursive: true });
    writeFileSync(envPath, formatEnv(cfg));
    console.log(`${c.green}✓${c.reset} wrote ${envPath}`);
  } else {
    console.log(`${c.gray}skipped writing .env — exiting without changes.${c.reset}`);
    closeRl(rl);
    return;
  }

  const start = (await ask(rl, "Start claude-code-free now?", "Y")).toLowerCase();
  closeRl(rl);
  if (start.startsWith("y") || start === "") {
    console.log(`\n${c.dim}Run again anytime with: claude-code-free${c.reset}`);
    console.log(`${c.dim}Switch models with:      claude-code-free --model${c.reset}`);
  } else {
    console.log(`\n${c.dim}Done. Run with: claude-code-free${c.reset}`);
    console.log(`${c.dim}Switch models with: claude-code-free --model${c.reset}`);
  }
}

// Run only when invoked directly.
const invokedAs = process.argv[1] ?? "";
const isMain = invokedAs.endsWith("setup.ts") || invokedAs.endsWith("setup.mjs");
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}