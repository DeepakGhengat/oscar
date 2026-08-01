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