import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const loaded = new Set<string>();

/** Parse KEY=VALUE text into a plain object. No side effects. */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** Load .env into process.env for keys not already set. Runs once per path. */
export function loadEnvFile(path?: string): void {
  const file = resolve(path ?? ".env");
  if (loaded.has(file)) return;
  loaded.add(file);
  if (!existsSync(file)) return;
  const parsed = parseEnvFile(readFileSync(file, "utf8"));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}