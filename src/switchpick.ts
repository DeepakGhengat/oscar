// `claude-code-free --switch`: talk to a *running* proxy's /_ccf/ control
// endpoints and hot-swap the backend model live, without restarting it.
//
// Use this from a second terminal while `claude` is running in the first.
// The proxy must already be up (the launcher starts it). This command reads
// the proxy port from the .env, probes /_ccf/models, shows a two-step picker
// (series -> model in series) plus "all models" and "set up" options, and
// POSTs the choice to /_ccf/model.
//
// Unlike `--model` (which rewrites .env and expects the proxy to be stopped),
// `--switch` mutates the live proxy's in-memory OPENAI_MODEL AND persists to
// .env, so the change sticks across restarts too.

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { banner, c, select, createQuestion, type SelectOption } from "./ui.ts";

/** Close readline without tripping the libuv assertion on piped stdin. */
function closeRl(rl: { close: () => void; pause?: () => void }): void {
  if (!process.stdin.isTTY) {
    try { process.stdin.unref(); } catch {}
    return;
  }
  try { rl.close(); } catch {}
}

function envFilePath(): string {
  const dir = process.env.CLAUDE_CODE_FREE_CONFIG;
  const candidate = dir ? resolve(dir) : resolve(".env");
  if (dir) return join(candidate, ".env");
  return candidate;
}

function readEnv(): Record<string, string> {
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

/** Group a flat list of model ids by series.
 *
 *  Series = the leading family token, taken up to the first `:` or `-`.
 *  e.g. deepseek-v4-flash -> deepseek, glm-5.1 -> glm, gpt-oss:120b -> gpt-oss,
 *  qwen3.5:397b -> qwen3.5. Models with no separator form their own group. */
function groupBySeries(models: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of models) {
    const sepIdx = Math.min(
      ...["-", ":"].map((s) => {
        const i = m.indexOf(s);
        return i < 0 ? m.length : i;
      }),
    );
    const series = sepIdx >= m.length ? m : m.slice(0, sepIdx);
    const arr = out.get(series);
    if (arr) arr.push(m);
    else out.set(series, [m]);
  }
  return out;
}

interface ModelsResponse {
  backend?: string;
  current?: string;
  models: string[];
}

async function fetchModels(port: number): Promise<ModelsResponse | null> {
  try {
    const res = await fetch(`http://localhost:${port}/_ccf/models`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as ModelsResponse;
  } catch {
    return null;
  }
}

async function postModel(port: number, model: string): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/_ccf/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function getStatus(port: number): Promise<{ openaiModel?: string } | null> {
  try {
    const res = await fetch(`http://localhost:${port}/_ccf/status`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    return (await res.json()) as { openaiModel?: string };
  } catch {
    return null;
  }
}

export async function runSwitchPicker(): Promise<string | null> {
  const env = readEnv();
  const port = Number(env.PROXY_PORT || 8787);

  console.log(banner("Switch model (live)", `proxy: http://localhost:${port}`));

  // Confirm the proxy is actually up and answering the control endpoints.
  const status = await getStatus(port);
  if (!status) {
    console.log(`${c.red}No proxy responding at http://localhost:${port}/_ccf/status.${c.reset}`);
    console.log(`Start ${c.bold}claude-code-free${c.reset} first in another terminal, then run ${c.bold}claude-code-free --switch${c.reset}.`);
    return null;
  }

  console.log(`${c.dim}Current model: ${c.reset}${c.bold}${status.openaiModel ?? "(none)"}${c.reset}`);
  console.log(`${c.dim}Probing /_ccf/models ...${c.reset}`);

  const data = await fetchModels(port);
  if (!data || !data.models.length) {
    console.log(`${c.yellow}  (proxy reachable but backend /models returned nothing)${c.reset}`);
    console.log(`  Check ${c.bold}OPENAI_BASE_URL${c.reset} in your .env, or run ${c.bold}claude-code-free --model${c.reset} to switch offline.`);
    return null;
  }

  const models = data.models.slice().sort((a, b) => a.localeCompare(b));
  const current = data.current ?? status.openaiModel ?? "";
  const seriesMap = groupBySeries(models);
  const seriesNames = [...seriesMap.keys()].sort((a, b) => a.localeCompare(b));

  const rl = createInterface({ input, output });
  const ask = createQuestion(rl);

  // Series menu: one entry per series + "all models" + "set up".
  const seriesOptions: SelectOption[] = seriesNames.map((s) => {
    const count = seriesMap.get(s)!.length;
    const isCurrent = seriesMap.get(s)!.includes(current);
    const mark = isCurrent ? ` ${c.green}(active)${c.reset}` : "";
    return { label: `${c.bold}${s}${c.reset}${c.gray} (${count})${c.reset}${mark}` };
  });
  seriesOptions.push({ label: `${c.gray}All models (flat list)${c.reset}` });
  seriesOptions.push({ label: `${c.gray}Set up / reconfigure backend${c.reset}` });

  const idx = await select(rl, seriesOptions, "Pick a series");

  // "Set up" — tell the user to run --setup (we can't run it from inside this
  // process cleanly because it would clobber the running proxy's .env mid-edit
  // and the proxy reloads .env lazily; safer to point them at the command).
  if (idx === seriesOptions.length - 1) {
    closeRl(rl);
    console.log(`\nRun ${c.bold}claude-code-free --setup${c.reset} to reconfigure the backend, then restart claude.`);
    return null;
  }

  // "All models" — flatten to the full sorted list.
  let chosen: string | null = null;
  if (idx === seriesOptions.length - 2) {
    const allOptions: SelectOption[] = models.map((m) => ({
      label: m === current ? `${c.bold}${m}${c.reset} ${c.green}(active)${c.reset}` : m,
    }));
    const mi = await select(rl, allOptions, "Pick a model");
    chosen = models[mi]!;
  } else {
    // Series -> model in series.
    const series = seriesNames[idx]!;
    const inSeries = seriesMap.get(series)!.slice().sort((a, b) => a.localeCompare(b));
    const modelOptions: SelectOption[] = inSeries.map((m) => ({
      label: m === current ? `${c.bold}${m}${c.reset} ${c.green}(active)${c.reset}` : m,
    }));
    const mi = await select(rl, modelOptions, `Pick a ${c.bold}${series}${c.reset} model`);
    chosen = inSeries[mi]!;
  }

  closeRl(rl);

  if (chosen === current) {
    console.log(`${c.gray}already active — no change${c.reset}`);
    return chosen;
  }

  const ok = await postModel(port, chosen);
  if (!ok) {
    console.log(`${c.red}✗ proxy rejected the switch${c.reset}`);
    return null;
  }
  console.log(`${c.green}✓${c.reset} switched OPENAI_MODEL → ${c.bold}${chosen}${c.reset} (live + persisted to .env)`);
  return chosen;
}

const invokedAs = process.argv[1] ?? "";
const isMain = invokedAs.endsWith("switchpick.ts") || invokedAs.endsWith("switchpick.mjs");
if (isMain) {
  runSwitchPicker()
    .then((m) => { process.exitCode = m ? 0 : 1; })
    .catch((err) => { console.error(err); process.exitCode = 1; });
}