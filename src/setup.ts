// Interactive setup wizard for oscar.
// Pure helpers are exported for testing; main() runs the interactive loop.

export type ProviderId =
  | "openai" | "deepseek" | "ollama" | "lmstudio" | "vllm" | "custom"
  | "subscription" | "passthrough";

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  baseURL: string | null;
  defaultModel: string | null;
  keyHint: string | null;
  kind: "cloud" | "local" | "custom" | "subscription" | "passthrough";
}

/** Can O.S.C.A.R.'s built-in agent (`oscar --agent`) talk to this preset
 * directly? Only OpenAI-compatible backends qualify — the Anthropic modes are
 * driven by the coding CLI, which is the default launcher path.
 *
 * This describes a capability. It is not a filter on what the wizard offers. */
export function agentCapable(p: ProviderPreset): boolean {
  return p.kind !== "subscription" && p.kind !== "passthrough";
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "openai",      label: "OpenAI",                baseURL: "https://api.openai.com/v1",  defaultModel: "gpt-4o-mini", keyHint: null,         kind: "cloud" },
  { id: "deepseek",    label: "DeepSeek",              baseURL: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat", keyHint: null,       kind: "cloud" },
  { id: "ollama",      label: "Ollama (local)",        baseURL: "http://localhost:11434/v1",   defaultModel: "llama3",      keyHint: "ollama",     kind: "local" },
  { id: "lmstudio",    label: "LM Studio (local)",     baseURL: "http://localhost:1234/v1",    defaultModel: null,          keyHint: "lm-studio",  kind: "local" },
  { id: "vllm",        label: "vLLM (local)",          baseURL: "http://localhost:8000/v1",    defaultModel: null,          keyHint: "vllm",       kind: "local" },
  { id: "custom",      label: "Custom OpenAI-compatible", baseURL: null,                       defaultModel: null,          keyHint: null,         kind: "custom" },
  { id: "subscription", label: "Anthropic account sign-in (Pro / Max / Team / SSO)", baseURL: null, defaultModel: null,      keyHint: null,         kind: "subscription" },
  { id: "passthrough", label: "Anthropic API key",        baseURL: null,                          defaultModel: null,          keyHint: null,         kind: "passthrough" },
];

export interface SetupConfig {
  useOpenAI: boolean;
  openAIKey: string | null;
  openAIModel: string | null;
  openAIBaseURL: string | null;
  upstreamKey: string | null;
  /** Set when the CLI signs itself in and holds no key on our side. */
  subscription?: boolean;
  port: number;
}

/** Default port for the local proxy, when one runs at all. */
export const DEFAULT_PORT = 8787;

/** Serialize a SetupConfig to .env text. */
export function formatEnv(cfg: SetupConfig): string {
  const lines: string[] = [];
  lines.push(`# oscar config — written by src/setup.ts`);
  // Account sign-in launches the CLI directly — no proxy, so no port. Writing
  // one would imply a local server that never starts.
  if (!cfg.subscription) lines.push(`PROXY_PORT=${cfg.port}`);
  if (cfg.useOpenAI) {
    lines.push(`USE_OPENAI_API=1`);
    lines.push(`OPENAI_API_KEY=${cfg.openAIKey ?? ""}`);
    lines.push(`OPENAI_MODEL=${cfg.openAIModel ?? ""}`);
    lines.push(`OPENAI_BASE_URL=${cfg.openAIBaseURL ?? ""}`);
  }
  if (cfg.subscription) {
    // No key to store: the CLI signs itself in and refreshes its own token.
    lines.push(`OSCAR_AUTH=subscription`);
  }
  if (cfg.upstreamKey) {
    lines.push(`ANTHROPIC_API_KEY=${cfg.upstreamKey}`);
  }
  return lines.join("\n") + "\n";
}

/** Probe an OpenAI-compatible /models endpoint. Returns [] on any failure/timeout.
 *
 * `timeoutMs` matters: 2s is fine for a warm local server but can cut off a
 * remote backend's first request, where DNS and the TLS handshake land before
 * any response. Callers that can afford to wait should ask for more. */
export async function probeModels(
  baseURL: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 2000,
): Promise<string[]> {
  try {
    const res = await fetchImpl(`${baseURL.replace(/\/$/, "")}/models`, {
      signal: AbortSignal.timeout(timeoutMs),
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
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { banner, box, c, createQuestion, select, type SelectOption } from "./ui.ts";
import { verifyBackend } from "./preflight.ts";
import { describeProfile, listProfiles, parseEnvText, saveProfile } from "./profiles.ts";

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
  console.log(banner("O.S.C.A.R. setup", "Orchestrator for System Coding & Autonomous Routing"));

  // Every backend is offered, including both Anthropic modes. Account sign-in
  // is how a paid plan is used at all, and it is the reason the launcher knows
  // how to find and start the coding CLI. Hiding those two would remove the
  // product's original purpose, not rebrand it.
  const presets = PROVIDER_PRESETS;

  const providerOptions: SelectOption[] = presets.map((p) => ({
    label: p.label,
    description: p.kind === "local" ? "local" : p.kind,
  }));
  const idx = await select(rl, providerOptions, "Choose a backend");
  const preset = presets[idx]!;

  let useOpenAI = false;
  let openAIKey: string | null = null;
  let openAIModel: string | null = null;
  let openAIBaseURL: string | null = null;
  let upstreamKey: string | null = null;
  let subscription = false;
  // Only meaningful when a proxy actually runs. Account sign-in launches the
  // CLI directly, so nothing ever binds a port and asking for one is noise.
  let port = DEFAULT_PORT;

  if (preset.kind === "subscription") {
    subscription = true;
    console.log(
      `\n${c.yellow}Note:${c.reset} this mode drives the ${c.bold}external CLI${c.reset}, not the O.S.C.A.R. agent.\n` +
      `${c.dim}Those credentials belong to that vendor's application and only it can\n` +
      `use them, so the O.S.C.A.R. agent has no backend to call. ${c.reset}${c.bold}oscar${c.reset}${c.dim} will\n` +
      `launch the external CLI instead of the O.S.C.A.R. interface.\n\n` +
      `Nothing to collect — no key, no port, no local server. Run ${c.reset}${c.bold}/login${c.reset}${c.dim}\n` +
      `inside the CLI if you are not signed in yet; SSO, Bedrock and Vertex\n` +
      `work as usual.\n\n` +
      `For the O.S.C.A.R. agent, pick a backend instead: Ollama, OpenAI,\n` +
      `DeepSeek, LM Studio, vLLM or any OpenAI-compatible server.${c.reset}\n`,
    );
  } else if (preset.kind === "passthrough") {
    port = Number(await ask(rl, "Proxy port", String(DEFAULT_PORT))) || DEFAULT_PORT;
    upstreamKey = await askRequired(rl, "Anthropic API key");
  } else {
    port = Number(await ask(rl, "Proxy port", String(DEFAULT_PORT))) || DEFAULT_PORT;
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

  // Verify with a real completion before writing anything. Listing models is
  // not proof: on hosted Ollama the /models endpoint answers 200 to anyone, so
  // a placeholder key sails through and only fails later, mid-conversation.
  if (useOpenAI && openAIBaseURL && openAIModel) {
    for (;;) {
      console.log(`${c.dim}Checking ${openAIModel} with a one-token request ...${c.reset}`);
      const check = await verifyBackend({ baseURL: openAIBaseURL, apiKey: openAIKey, model: openAIModel });
      if (check.ok) {
        console.log(`${c.green}✓${c.reset} backend works`);
        break;
      }
      console.log(`${c.red}✗${c.reset} ${check.message}`);
      if (check.kind !== "auth") break; // only a bad key is worth retrying here
      const retry = (await ask(rl, "Enter a different API key? (blank to keep and continue)", "")).trim();
      if (!retry) break;
      openAIKey = retry;
    }
  }

  const cfg: SetupConfig = { useOpenAI, openAIKey, openAIModel, openAIBaseURL, upstreamKey, subscription, port };

  const summary = useOpenAI
    ? `provider:  ${preset.label}\nbase URL:  ${openAIBaseURL}\nmodel:     ${openAIModel}\nkey:       ${openAIKey ? openAIKey.slice(0, 4) + "..." : "(none)"}\nport:      ${port}`
    : subscription
      ? `provider:  ${preset.label}\nauth:      handled by the CLI (no key, no proxy)`
      : `provider:      ${preset.label}\nanthropic key: ${upstreamKey ? upstreamKey.slice(0, 4) + "..." : "(none)"}\nport:          ${port}`;
  console.log(`\n${box(summary)}\n`);

  const write = (await ask(rl, "Write .env?", "Y")).toLowerCase();
  if (write.startsWith("y") || write === "") {
    // Global install: config lives at $OSCAR_CONFIG (set by the
    // bin launcher, typically ~/.oscar/.env). Local dev: write to
    // the project root .env.
    const dir = process.env.OSCAR_CONFIG;
    const envPath = dir ? resolve(dir, ".env") : resolve(".env");
    if (dir) mkdirSync(dir, { recursive: true });

    // Whatever is being replaced is worth keeping. Without this, setting up a
    // second backend discards the first — base URL, key and model — and the
    // only way back is to type it all in again.
    if (existsSync(envPath)) {
      try {
        const previous = readFileSync(envPath, "utf8");
        if (previous.trim() && !listProfiles().some((p) => p.active)) {
          saveProfile(profileNameFor(previous), previous);
        }
      } catch {
        // Not worth failing the write over.
      }
    }

    const text = formatEnv(cfg);
    writeFileSync(envPath, text);
    console.log(`${c.green}✓${c.reset} wrote ${envPath}`);

    const saved = saveProfile(preset.id, text);
    if (saved) {
      console.log(`${c.green}✓${c.reset} saved as profile ${c.bold}${preset.id}${c.reset}`);
    }
  } else {
    console.log(`${c.gray}skipped writing .env — exiting without changes.${c.reset}`);
    closeRl(rl);
    return;
  }

  closeRl(rl);
  console.log(`\n${c.dim}Run with: ${c.reset}${c.bold}oscar${c.reset}`);
  // `--model` rewrites OPENAI_MODEL, which does not exist under account
  // sign-in — there the CLI's own picker is the only thing that applies.
  console.log(
    subscription
      ? `${c.dim}Switch models inside the CLI with ${c.reset}${c.bold}/model${c.reset}`
      : `${c.dim}Switch models with: ${c.reset}${c.bold}oscar --model${c.reset}`,
  );
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
/** A profile name for a config we are about to replace, derived from what it
 * actually is rather than from whichever preset happened to create it. */
export function profileNameFor(envText: string): string {
  const env = parseEnvText(envText);
  if (["1", "true", "yes", "on"].includes((env.USE_OPENAI_API ?? "").toLowerCase())) {
    const host = (env.OPENAI_BASE_URL ?? "").replace(/^https?:\/\//, "").split(/[/:]/)[0] ?? "";
    if (host.includes("ollama")) return "ollama";
    if (host.includes("deepseek")) return "deepseek";
    if (host.includes("openai")) return "openai";
    if (host === "localhost" || host === "127.0.0.1") return "local";
    return host ? host.replace(/\./g, "-") : "openai-compatible";
  }
  return describeProfile(envText).startsWith("Anthropic API key") ? "passthrough" : "subscription";
}
