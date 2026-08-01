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
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

async function ask(rl: ReturnType<typeof createInterface>, q: string, fallback?: string): Promise<string> {
  const prompt = fallback !== undefined ? `${q} [${fallback}]: ` : `${q}: `;
  const answer = (await rl.question(prompt)).trim();
  return answer.length ? answer : (fallback ?? "");
}

async function askRequired(rl: ReturnType<typeof createInterface>, q: string): Promise<string> {
  for (;;) {
    const a = (await rl.question(`${q}: `)).trim();
    if (a) return a;
    console.log("  (required, try again)");
  }
}

function pickNumber(rl: ReturnType<typeof createInterface>, options: string[], prompt: string): Promise<number> {
  return (async () => {
    for (;;) {
      options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`));
      const a = (await rl.question(`${prompt}: `)).trim();
      const n = Number(a);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
      console.log("  (invalid choice, try again)");
    }
  })();
}

export async function main(): Promise<void> {
  const rl = createInterface({ input, output });
  console.log("\n=== claude-code-free setup ===\n");

  const idx = await pickNumber(
    rl,
    PROVIDER_PRESETS.map((p) => p.label),
    "Choose an LLM provider",
  );
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

    // model selection
    if (preset.kind === "local") {
      const models = await probeModels(openAIBaseURL);
      if (models.length) {
        const choice = await pickNumber(rl, [...models, "Type manually"], "Pick a model");
        openAIModel = choice < models.length ? models[choice]! : await askRequired(rl, "Model name");
      } else {
        console.log(`  (could not reach ${openAIBaseURL}/models — enter the model name manually)`);
        openAIModel = preset.defaultModel
          ? await ask(rl, "Model name", preset.defaultModel)
          : await askRequired(rl, "Model name");
      }
    } else if (preset.defaultModel) {
      openAIModel = await ask(rl, "Model", preset.defaultModel);
    } else {
      openAIModel = await askRequired(rl, "Model name");
    }

    openAIKey = preset.keyHint
      ? (await ask(rl, "API key (local servers usually ignore this)", preset.keyHint) || preset.keyHint)
      : await askRequired(rl, "API key");
  }

  const cfg: SetupConfig = { useOpenAI, openAIKey, openAIModel, openAIBaseURL, anthropicKey, port };

  console.log("\n--- summary ---");
  console.log(`  provider: ${preset.label}`);
  if (useOpenAI) {
    console.log(`  base URL: ${openAIBaseURL}`);
    console.log(`  model:    ${openAIModel}`);
    console.log(`  key:      ${openAIKey ? openAIKey.slice(0, 4) + "..." : "(none)"}`);
  } else {
    console.log(`  anthropic key: ${anthropicKey ? anthropicKey.slice(0, 4) + "..." : "(none)"}`);
  }
  console.log(`  port: ${port}\n`);

  const write = (await ask(rl, "Write .env?", "Y")).toLowerCase();
  if (write.startsWith("y") || write === "") {
    // Global install: config lives at $CLAUDE_CODE_FREE_CONFIG (set by the
    // bin launcher, typically ~/.claude-code-free/.env). Local dev: write to
    // the project root .env.
    const dir = process.env.CLAUDE_CODE_FREE_CONFIG;
    const envPath = dir ? resolve(dir, ".env") : resolve(".env");
    if (dir) {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(envPath, formatEnv(cfg));
    console.log(`  wrote ${envPath}`);
  } else {
    console.log("  skipped writing .env — exiting without changes.");
    rl.close();
    return;
  }

  const start = (await ask(rl, "Start the proxy now?", "Y")).toLowerCase();
  rl.close();
  if (start.startsWith("y") || start === "") {
    const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", "src/server.ts"], {
      stdio: "inherit",
    });
    child.on("close", (code) => process.exit(code ?? 0));
  } else {
    console.log("\nDone. Run with: npx tsx src/server.ts  (or bash scripts/run.sh)");
  }
}

// Run only when invoked directly.
const invokedAs = process.argv[1] ?? "";
const isMain = invokedAs.endsWith("setup.ts") || invokedAs.endsWith("setup.mjs");
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}