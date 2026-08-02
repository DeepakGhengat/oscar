// `oscar --model`: list models from the configured backend and
// switch OPENAI_MODEL in the .env without re-running the whole wizard.
//
// Unlike setups that read a static provider config, this probes the
// live backend /models endpoint so the list reflects what is actually
// available.

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { banner, c, select } from "./ui.ts";

/** Close readline without triggering the libuv assertion on piped stdin (Windows).
 *  On non-TTY stdin, unref the handle so the loop can exit naturally instead of
 *  hitting the uv_loop_close assert from process.exit() while a handle is open. */
function closeRl(rl: { close: () => void; pause?: () => void }): void {
  if (!process.stdin.isTTY) {
    try { process.stdin.unref(); } catch {}
    return;
  }
  try { rl.close(); } catch {}
}
import { probeModels } from "./setup.ts";

export function envFilePath(): string {
  const dir = process.env.OSCAR_CONFIG;
  const candidate = dir ? resolve(dir) : resolve(".env");
  // dir -> dir/.env ; file -> file
  if (dir) return join(candidate, ".env");
  return candidate;
}

function currentEnv(): Record<string, string> {
  const file = envFilePath();
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k) out[k] = v;
  }
  return out;
}

/** Rewrite a single KEY=VALUE line in the .env, preserving everything else. */
export function rewriteKey(file: string, key: string, value: string): void {
  const raw = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = raw.split(/\r?\n/);
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    if (line.slice(0, eq).trim() === key) {
      lines[i] = `${key}=${value}`;
      found = true;
      break;
    }
  }
  if (!found) {
    // A file ending in "\n" splits to a trailing "" element. Appending after
    // it would wedge a blank line in — and one more on every later append.
    while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
    lines.push(`${key}=${value}`);
  }
  writeFileSync(file, lines.join("\n").replace(/\n*$/, "\n"));
}

/** Run the model picker. Returns the chosen model id, or null if cancelled. */
export async function runModelPicker(): Promise<string | null> {
  const file = envFilePath();
  if (!existsSync(file)) {
    console.log(`${c.red}No config found at ${file}.${c.reset}`);
    console.log(`Run ${c.bold}oscar --setup${c.reset} first.`);
    return null;
  }

  const env = currentEnv();
  const baseURL = (env.OPENAI_BASE_URL ?? "").replace(/\/$/, "");
  const current = env.OPENAI_MODEL ?? "";
  const key = env.OPENAI_API_KEY ?? "";

  if (!baseURL) {
    console.log(`${c.red}No OPENAI_BASE_URL in ${file}.${c.reset}`);
    return null;
  }

  console.log(banner("Switch model", `backend: ${baseURL}`));
  console.log(`${c.dim}Probing /models ...${c.reset}`);

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  const models = await probeModels(baseURL, (url, init) =>
    fetch(url, { ...init, headers: { ...headers, ...((init?.headers as Record<string, string>) ?? {}) } } as RequestInit),
  );
  models.sort((a, b) => a.localeCompare(b));

  if (!models.length) {
    console.log(`${c.yellow}  (could not reach ${baseURL}/models)${c.reset}`);
    console.log(`  Enter a model name manually, or re-run ${c.bold}oscar --setup${c.reset}.`);
    const rl = createInterface({ input, output });
    const manual = (await rl.question(`${c.bold}Model name${c.reset} [${c.gray}cancel=Enter${c.reset}]: `)).trim();
    closeRl(rl);
    if (!manual) return null;
    rewriteKey(file, "OPENAI_MODEL", manual);
    console.log(`${c.green}✓${c.reset} set OPENAI_MODEL=${c.bold}${manual}${c.reset}`);
    return manual;
  }

  const rl = createInterface({ input, output });
  const options = models.map((m) => ({
    label: m === current ? `${c.bold}${m}${c.reset} ${c.green}(active)${c.reset}` : m,
  }));
  options.push({ label: `${c.gray}Type manually${c.reset}` });

  const idx = await select(rl, options, "Pick a model");
  closeRl(rl);

  if (idx >= models.length) {
    const rl2 = createInterface({ input, output });
    const manual = (await rl2.question(`${c.bold}Model name${c.reset}: `)).trim();
    closeRl(rl2);
    if (!manual) {
      console.log(`${c.gray}cancelled${c.reset}`);
      return null;
    }
    rewriteKey(file, "OPENAI_MODEL", manual);
    console.log(`${c.green}✓${c.reset} set OPENAI_MODEL=${c.bold}${manual}${c.reset}`);
    return manual;
  }

  const chosen = models[idx]!;
  if (chosen === current) {
    console.log(`${c.gray}already active — no change${c.reset}`);
    return chosen;
  }
  rewriteKey(file, "OPENAI_MODEL", chosen);
  console.log(`${c.green}✓${c.reset} set OPENAI_MODEL=${c.bold}${chosen}${c.reset}`);
  return chosen;
}

const invokedAs = process.argv[1] ?? "";
const isMain = invokedAs.endsWith("modelpicker.ts") || invokedAs.endsWith("modelpicker.mjs");
if (isMain) {
  runModelPicker()
    .then((m) => {
      // Set exit code without forcing process.exit() — that trips a libuv
      // assert on Windows when a readline handle is still tearing down.
      process.exitCode = m ? 0 : 1;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}