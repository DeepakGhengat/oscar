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

  // Account sign-in configures no OpenAI-compatible backend, so the agent has
  // nothing to talk to. Say that plainly instead of reporting an empty model
  // list, which sends people looking for a network fault that isn't there.
  if (!cfg.useOpenAI && !cfg.openAIKey && !process.env.OPENAI_BASE_URL) {
    console.error(
      `${c.red}No backend configured for the O.S.C.A.R. agent.${c.reset}\n\n` +
        `Your config selects account sign-in, which belongs to the external CLI —\n` +
        `those credentials only work in that application, so the agent has nothing\n` +
        `to call.\n\n` +
        `  ${c.bold}oscar --setup${c.reset}   pick a backend (Ollama, OpenAI, DeepSeek, …)\n` +
        `  ${c.bold}oscar --cli${c.reset}     keep account sign-in and drive the external CLI\n`,
    );
    return 1;
  }

  const choices = await listChoices(providers);
  if (!choices.size) {
    const list = providers.map((p) => `    ${p.id}  ${p.baseURL}`).join("\n");
    console.error(
      `${c.red}No models available.${c.reset} None of these answered /models:\n\n${list}\n\n` +
        `  ${c.bold}oscar --doctor${c.reset}   test each backend with a real request\n` +
        `  ${c.bold}oscar --setup${c.reset}    reconfigure\n\n` +
        `${c.gray}If you meant to use a local server, check it is running.${c.reset}`,
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
