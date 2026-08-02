// `claude-code-free --doctor` — check the whole chain before you need it.
//
// Exists because the failure this catches is nearly undiagnosable from the
// symptom: a placeholder API key passes the wizard's /models probe (listing is
// public on Ollama Cloud) and then surfaces mid-conversation as a 401 that
// looks like Claude Code's own login expiring.

import { existsSync, readFileSync } from "node:fs";
import { c } from "./ui.ts";
import { envFilePath } from "./modelpicker.ts";
import { probeModels } from "./setup.ts";
import { isPlaceholderKey, isRemoteBackend, verifyBackend } from "./preflight.ts";

const PASS = `${c.green}✓${c.reset}`;
const FAIL = `${c.red}✗${c.reset}`;
const WARN = `${c.yellow}!${c.reset}`;

function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}

/** Run every check. Returns true when the config should actually work. */
export async function runDoctor(): Promise<boolean> {
  const file = envFilePath();
  console.log(`${c.bold}claude-code-free doctor${c.reset}`);
  console.log(`${c.dim}config: ${file}${c.reset}\n`);

  if (!existsSync(file)) {
    console.log(`${FAIL} no config found — run ${c.bold}claude-code-free --setup${c.reset}`);
    return false;
  }
  console.log(`${PASS} config file present`);

  const env = readEnvFile(file);
  if (!["1", "true", "yes", "on"].includes((env.USE_OPENAI_API ?? "").toLowerCase())) {
    console.log(`${PASS} passthrough mode (USE_OPENAI_API is off) — nothing else to check`);
    return true;
  }

  const baseURL = (env.OPENAI_BASE_URL ?? "").replace(/\/$/, "");
  const key = env.OPENAI_API_KEY ?? "";
  const model = env.OPENAI_MODEL ?? "";
  let ok = true;

  for (const [name, value] of [["OPENAI_BASE_URL", baseURL], ["OPENAI_MODEL", model]] as const) {
    if (!value) {
      console.log(`${FAIL} ${name} is not set`);
      ok = false;
    }
  }
  if (!ok) return false;
  console.log(`${PASS} backend: ${baseURL}`);
  console.log(`${PASS} model:   ${model}`);

  // A placeholder key is fine for a local server, fatal for a hosted one.
  if (isPlaceholderKey(key)) {
    if (isRemoteBackend(baseURL)) {
      console.log(
        `${FAIL} OPENAI_API_KEY is the placeholder ${JSON.stringify(key)}, but ${baseURL} is a hosted backend that needs a real key`,
      );
      ok = false;
    } else {
      console.log(`${PASS} key: placeholder, which is fine for a local backend`);
    }
  } else {
    console.log(`${PASS} key: set (${key.slice(0, 4)}...)`);
  }

  // Model listing — note explicitly that passing proves little.
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  const ids = await probeModels(baseURL, (url, init) =>
    fetch(url, { ...init, headers: { ...headers, ...((init?.headers as Record<string, string>) ?? {}) } } as RequestInit),
  );
  if (ids.length) {
    console.log(`${PASS} /models lists ${ids.length} model(s) ${c.dim}(often public — proves reachability, not auth)${c.reset}`);
    if (!ids.includes(model)) {
      console.log(`${WARN} ${JSON.stringify(model)} is not in that list — closest: ${nearest(model, ids).join(", ") || "(none)"}`);
    }
  } else {
    console.log(`${WARN} /models returned nothing — the picker in /model will be empty`);
  }

  // The check that actually means something.
  const result = await verifyBackend({ baseURL, apiKey: key || null, model });
  if (result.ok) {
    console.log(`${PASS} live completion succeeded — the backend works`);
  } else {
    console.log(`${FAIL} live completion failed: ${result.message}`);
    if (result.kind === "auth") {
      console.log(`  ${c.dim}Get a real key for ${baseURL} and set OPENAI_API_KEY in ${file}.${c.reset}`);
    } else if (result.kind === "model") {
      console.log(`  ${c.dim}Pick a served model with: claude-code-free --model${c.reset}`);
    }
    ok = false;
  }

  console.log(
    ok ? `\n${c.green}All checks passed.${c.reset}` : `\n${c.red}Some checks failed — see above.${c.reset}`,
  );
  return ok;
}

/** Cheap "did you mean" over the advertised ids. */
function nearest(want: string, ids: string[]): string[] {
  const stem = want.toLowerCase().split(/[:@]/)[0] ?? want.toLowerCase();
  return ids.filter((id) => id.toLowerCase().includes(stem)).slice(0, 3);
}

const invokedAs = process.argv[1] ?? "";
if (invokedAs.endsWith("doctor.ts") || invokedAs.endsWith("doctor.mjs")) {
  runDoctor()
    .then((ok) => {
      process.exitCode = ok ? 0 : 1;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
