// `oscar --doctor` — check the whole chain before you need it.
//
// Exists because the failure this catches is nearly undiagnosable from the
// symptom: a placeholder API key passes the wizard's /models probe (listing is
// public on Ollama Cloud) and then surfaces mid-conversation as a 401 that
// looks like the CLI's own login expiring.

import { existsSync, readFileSync } from "node:fs";
import { c } from "./ui.ts";
import { envFilePath } from "./modelpicker.ts";
import { probeModels } from "./setup.ts";
import { isPlaceholderKey, isRemoteBackend, verifyBackend } from "./preflight.ts";
import { loadProviders } from "./providers.ts";

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
  console.log(`${c.bold}O.S.C.A.R. doctor${c.reset}`);
  console.log(`${c.dim}config: ${file}${c.reset}\n`);

  if (!existsSync(file)) {
    console.log(`${FAIL} no config found — run ${c.bold}oscar --setup${c.reset}`);
    return false;
  }
  console.log(`${PASS} config file present`);

  const env = readEnvFile(file);
  if (!["1", "true", "yes", "on"].includes((env.USE_OPENAI_API ?? "").toLowerCase())) {
    console.log(`${PASS} passthrough mode (USE_OPENAI_API is off) — nothing else to check`);
    return true;
  }

  const defaultModel = env.OPENAI_MODEL ?? "";
  let ok = true;

  // The provider list is whatever the proxy itself would use: providers.json
  // when present, else the flat OPENAI_* config as a single "default".
  const { providers, errors } = loadProviders({
    useOpenAI: true,
    openAIKey: env.OPENAI_API_KEY ?? null,
    openAIModel: defaultModel || null,
    openAIBaseURL: (env.OPENAI_BASE_URL ?? "").replace(/\/$/, ""),
    maxOutputTokens: null,
    upstreamKey: null,
    upstreamBaseURL: "https://api.anthropic.com",
    port: Number(env.PROXY_PORT ?? 8787),
  });
  for (const e of errors) {
    console.log(`${FAIL} ${e}`);
    ok = false;
  }
  if (providers.length > 1) console.log(`${PASS} ${providers.length} providers configured`);

  for (const p of providers) {
    const label = providers.length > 1 ? `[${p.id}] ` : "";
    console.log(`\n${c.bold}${label}${p.baseURL}${c.reset}`);

    if (!p.baseURL) {
      console.log(`${FAIL} ${label}no baseURL`);
      ok = false;
      continue;
    }

    // A placeholder key is fine for a local server, fatal for a hosted one.
    if (isPlaceholderKey(p.apiKey)) {
      if (isRemoteBackend(p.baseURL)) {
        console.log(
          `${FAIL} key is the placeholder ${JSON.stringify(p.apiKey ?? "")}, but this is a hosted backend that needs a real one`,
        );
        ok = false;
      } else {
        console.log(`${PASS} key: placeholder, fine for a local backend`);
      }
    } else {
      console.log(`${PASS} key: set (${(p.apiKey ?? "").slice(0, 4)}...)`);
    }

    // Model listing — note explicitly that passing proves little.
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (p.apiKey) headers.authorization = `Bearer ${p.apiKey}`;
    const ids = await probeModels(
      p.baseURL,
      (url, init) =>
        fetch(url, { ...init, headers: { ...headers, ...((init?.headers as Record<string, string>) ?? {}) } } as RequestInit),
      10_000,
    );
    if (!ids.length) {
      console.log(`${WARN} /models returned nothing — this backend contributes nothing to /model`);
      ok = false;
      continue;
    }
    console.log(`${PASS} /models lists ${ids.length} model(s) ${c.dim}(often public — proves reachability, not auth)${c.reset}`);

    // Which model to test: the configured default if this backend serves it,
    // else whatever it does serve.
    let model = defaultModel;
    if (!ids.includes(model)) {
      if (providers.length === 1) {
        console.log(
          `${WARN} ${JSON.stringify(model)} is not served here — closest: ${nearest(model, ids).join(", ") || "(none)"}`,
        );
        ok = false;
      }
      model = ids[0]!;
    }

    // The check that actually means something.
    const result = await verifyBackend({ baseURL: p.baseURL, apiKey: p.apiKey, model });
    if (result.ok) {
      console.log(`${PASS} live completion with ${model} succeeded`);
    } else {
      console.log(`${FAIL} live completion failed: ${result.message}`);
      if (result.kind === "auth") {
        console.log(`  ${c.dim}Set a real key for ${p.baseURL} in ${providers.length > 1 ? "providers.json" : file}.${c.reset}`);
      } else if (result.kind === "model") {
        console.log(`  ${c.dim}Pick a served model with: oscar --model${c.reset}`);
      }
      ok = false;
    }
  }
  console.log("");

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
