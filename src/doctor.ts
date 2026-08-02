// `oscar --doctor` — check the whole chain before you need it.
//
// Exists because the failure this catches is nearly undiagnosable from the
// symptom: a placeholder API key passes the wizard's /models probe (listing is
// public on Ollama Cloud) and then surfaces mid-conversation as a 401 that
// looks like the CLI's own login expiring.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { c } from "./ui.ts";
import { envFilePath } from "./modelpicker.ts";
import { probeModels } from "./setup.ts";
import { isPlaceholderKey, isRemoteBackend, verifyBackend } from "./preflight.ts";
import { loadProviders } from "./providers.ts";
import { resolveUpstreamAuth } from "./env.ts";

/** Has the CLI stored an account login? null when we cannot tell — on macOS
 * the credentials live in the keychain, not on disk, so absence proves
 * nothing and we say nothing rather than raise a false alarm. */
export function hasStoredLogin(home = homedir(), platform = process.platform): boolean | null {
  if (platform === "darwin") return null;
  const dir = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  if (!existsSync(dir)) return false;
  return existsSync(join(dir, ".credentials.json"));
}

const PASS = `${c.green}✓${c.reset}`;
const FAIL = `${c.red}✗${c.reset}`;
const WARN = `${c.yellow}!${c.reset}`;

/** The config a real launch would see.
 *
 * loadEnvFile() only fills in keys that are not already in the environment, so
 * a shell-provided `USE_OPENAI_API=1 oscar` overrides the file. The doctor has
 * to apply the same precedence or it reports a configuration nobody is
 * actually running. */
export function effectiveEnv(
  fileEnv: Record<string, string>,
  processEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out = { ...fileEnv };
  for (const key of Object.keys(fileEnv).concat([
    "USE_OPENAI_API",
    "OSCAR_AUTH",
    "OPENAI_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "ANTHROPIC_API_KEY",
    "PROXY_PORT",
  ])) {
    const v = processEnv[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

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

  const env = effectiveEnv(readEnvFile(file));
  if (!["1", "true", "yes", "on"].includes((env.USE_OPENAI_API ?? "").toLowerCase())) {
    const auth = resolveUpstreamAuth(env.OSCAR_AUTH, env.ANTHROPIC_API_KEY || null);
    if (auth === "subscription") {
      console.log(`${PASS} account sign-in — the CLI authenticates itself, no key stored here`);
      console.log(`  ${c.dim}Credentials live in the CLI's own config or your OS keychain.${c.reset}`);
      console.log(`  ${c.dim}If requests are rejected, run /login inside the CLI.${c.reset}`);
      const signedIn = hasStoredLogin();
      if (signedIn === false) {
        console.log(`${WARN} no stored login found — run /login inside the CLI`);
      } else if (signedIn === true) {
        console.log(`${PASS} stored login found`);
      }
      return true;
    }
    console.log(`${PASS} passthrough with an API key (USE_OPENAI_API is off)`);
    if (!env.ANTHROPIC_API_KEY) {
      console.log(`${FAIL} ANTHROPIC_API_KEY is empty — set it, or switch to account sign-in with OSCAR_AUTH=subscription`);
      return false;
    }
    console.log(`${PASS} key: set (${env.ANTHROPIC_API_KEY.slice(0, 7)}...)`);
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
    upstreamAuth: "api-key",
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
