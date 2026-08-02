// `oscar` entry point: resolve the backend, list what it serves, start the REPL.
//
// No proxy is involved. O.S.C.A.R. is the agent now; the proxy in src/server.ts
// remains only for driving a third-party CLI, which is a separate mode.

import { loadConfig } from "../env.ts";
import { loadProviders, resolveMaxOutputTokens, type Provider } from "../providers.ts";
import { probeModels } from "../setup.ts";
import { c } from "../ui.ts";
import { runRepl, type ReplContext } from "./repl.ts";

/** Everything the picker can offer, as "provider/model". */
async function listChoices(providers: Provider[]): Promise<Map<string, { provider: Provider; model: string }>> {
  const out = new Map<string, { provider: Provider; model: string }>();
  const listings = await Promise.all(
    providers.map(async (provider) => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
      const ids = await probeModels(
        provider.baseURL,
        (url, init) =>
          fetch(url, {
            ...init,
            headers: { ...headers, ...((init?.headers as Record<string, string>) ?? {}) },
          } as RequestInit),
        10_000,
      );
      return { provider, ids };
    }),
  );
  for (const { provider, ids } of listings) {
    for (const id of ids.sort((a, b) => a.localeCompare(b))) {
      if (/(?:^|[-_/])(?:embed|embedding|rerank)(?:$|[-_:/.])/i.test(id)) continue;
      out.set(`${provider.id}/${id}`, { provider, model: id });
    }
  }
  return out;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const cfg = loadConfig();
  const { providers, errors } = loadProviders(cfg);
  for (const e of errors) console.error(`${c.yellow}!${c.reset} ${e}`);

  if (!providers.length || !providers[0]?.baseURL) {
    console.error(`${c.red}No backend configured.${c.reset} Run ${c.bold}oscar --setup${c.reset} first.`);
    return 1;
  }

  const choices = await listChoices(providers);
  if (!choices.size) {
    console.error(
      `${c.red}No models available.${c.reset} None of the configured backends answered /models.\n` +
        `Run ${c.bold}oscar --doctor${c.reset} to find out why.`,
    );
    return 1;
  }

  // Start on the configured model when the backend actually serves it.
  const first = providers[0]!;
  const preferred = cfg.openAIModel ? `${first.id}/${cfg.openAIModel}` : "";
  const start = choices.get(preferred) ?? choices.values().next().value!;
  if (preferred && !choices.get(preferred)) {
    console.error(
      `${c.yellow}!${c.reset} ${cfg.openAIModel} is not served by ${first.id}; starting on ${start.model}`,
    );
  }

  const ctx: ReplContext = {
    provider: start.provider,
    model: start.model,
    choices: [...choices.keys()],
    cwd: process.cwd(),
    onModelChange: (choice) => choices.get(choice) ?? null,
  };

  await runRepl(ctx, { autoApprove: argv.includes("--yes") || argv.includes("-y") });
  return 0;
}

const invokedAs = process.argv[1] ?? "";
if (invokedAs.endsWith("main.ts") || invokedAs.endsWith("main.mjs")) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}

export { resolveMaxOutputTokens };
