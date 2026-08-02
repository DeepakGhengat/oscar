// O.S.C.A.R.'s terminal interface.
//
// Deliberately plain: readline, ANSI, and nothing else. A coding agent should
// start instantly and behave the same over SSH, in CI logs and inside a
// pipe — which rules out a full-screen renderer.

import { createInterface, type Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { basename } from "node:path";
import { c } from "../ui.ts";
import { Agent, type Decision } from "../agent/loop.ts";
import type { Tool } from "../agent/tools.ts";
import type { Provider } from "../providers.ts";

export const WORDMARK = [
  "  ██████╗ ███████╗ ██████╗ █████╗ ██████╗ ",
  " ██╔═══██╗██╔════╝██╔════╝██╔══██╗██╔══██╗",
  " ██║   ██║███████╗██║     ███████║██████╔╝",
  " ██║   ██║╚════██║██║     ██╔══██║██╔══██╗",
  " ╚██████╔╝███████║╚██████╗██║  ██║██║  ██║",
  "  ╚═════╝ ╚══════╝ ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝",
];

export interface ReplContext {
  provider: Provider;
  model: string;
  /** Everything selectable from /model, as "provider/model". */
  choices: string[];
  cwd: string;
  onModelChange: (choice: string) => { provider: Provider; model: string } | null;
}

export function welcome(ctx: ReplContext): string {
  const out = ["", ...WORDMARK.map((l) => `${c.cyan}${l}${c.reset}`)];
  out.push(`${c.gray} Orchestrator for System Coding & Autonomous Routing${c.reset}`, "");
  out.push(` ${c.bold}model${c.reset}   ${ctx.model} ${c.gray}(${ctx.provider.id})${c.reset}`);
  out.push(` ${c.bold}dir${c.reset}     ${basename(ctx.cwd)}`);
  out.push("");
  out.push(` ${c.gray}/help for commands · /exit to quit${c.reset}`);
  out.push("");
  return out.join("\n");
}

const HELP = `
  ${c.bold}Commands${c.reset}
    /model            switch model or backend
    /models           list everything available
    /clear            forget the conversation
    /cwd              show the working directory
    /yes              stop asking before writes and commands
    /help             this
    /exit             quit

  ${c.bold}Anything else${c.reset} is sent to the model. It can read, write and
  edit files, search the project and run commands — you approve each
  write or command the first time.
`;

/** Ask once, accepting y / n / a. */
async function approve(rl: Interface, tool: Tool, summary: string): Promise<Decision> {
  const verb = tool.risk === "execute" ? "run a command" : "modify a file";
  process.stdout.write(
    `\n${c.yellow}?${c.reset} ${c.bold}${summary}${c.reset}\n` +
      `  ${c.gray}O.S.C.A.R. wants to ${verb}.${c.reset}\n`,
  );
  for (;;) {
    const a = (await rl.question(`  ${c.bold}[y]${c.reset}es / ${c.bold}[n]${c.reset}o / ${c.bold}[a]${c.reset}lways: `))
      .trim()
      .toLowerCase();
    if (a === "" || a === "y" || a === "yes") return "allow";
    if (a === "n" || a === "no") return "deny";
    if (a === "a" || a === "always") return "always";
  }
}

export async function runRepl(ctx: ReplContext, opts: { autoApprove?: boolean } = {}): Promise<void> {
  console.log(welcome(ctx));

  let { provider, model } = ctx;
  const rl = createInterface({ input, output });
  let agent = new Agent({ provider, model, cwd: ctx.cwd });
  if (opts.autoApprove) agent.grantAll();

  const rebuild = () => {
    agent = new Agent({ provider, model, cwd: ctx.cwd });
    if (opts.autoApprove) agent.grantAll();
  };

  for (;;) {
    let line: string;
    try {
      line = (await rl.question(`${c.cyan}❯${c.reset} `)).trim();
    } catch {
      break; // ctrl-d
    }
    if (!line) continue;

    /* ------------------------------ commands ------------------------------ */
    if (line === "/exit" || line === "/quit") break;
    if (line === "/help") {
      console.log(HELP);
      continue;
    }
    if (line === "/clear") {
      agent.reset();
      console.log(`${c.gray}conversation cleared${c.reset}\n`);
      continue;
    }
    if (line === "/cwd") {
      console.log(`${c.gray}${ctx.cwd}${c.reset}\n`);
      continue;
    }
    if (line === "/yes") {
      agent.grantAll();
      console.log(`${c.gray}writes and commands will run without asking${c.reset}\n`);
      continue;
    }
    if (line === "/models") {
      for (const choice of ctx.choices) {
        const active = choice === `${provider.id}/${model}`;
        console.log(`  ${active ? `${c.green}●${c.reset}` : " "} ${choice}`);
      }
      console.log("");
      continue;
    }
    if (line === "/model" || line.startsWith("/model ")) {
      const arg = line.slice(6).trim();
      const picked = arg || (await pickModel(rl, ctx.choices, `${provider.id}/${model}`));
      if (!picked) continue;
      const next = ctx.onModelChange(picked);
      if (!next) {
        console.log(`${c.red}unknown model: ${picked}${c.reset}\n`);
        continue;
      }
      provider = next.provider;
      model = next.model;
      rebuild();
      console.log(`${c.green}✓${c.reset} now using ${c.bold}${model}${c.reset} ${c.gray}(${provider.id})${c.reset}\n`);
      continue;
    }
    if (line.startsWith("/")) {
      console.log(`${c.red}unknown command: ${line}${c.reset}  ${c.gray}try /help${c.reset}\n`);
      continue;
    }

    /* -------------------------------- turn -------------------------------- */
    let printedText = false;
    try {
      await agent.send(line, {
        onText: (d) => {
          if (!printedText) {
            process.stdout.write("\n");
            printedText = true;
          }
          process.stdout.write(d);
        },
        onReasoning: (d) => process.stdout.write(`${c.gray}${d}${c.reset}`),
        onApprove: (tool, summary) => approve(rl, tool, summary),
        onToolResult: (tool, summary, result, denied) => {
          const mark = denied ? `${c.red}✗${c.reset}` : `${c.green}✓${c.reset}`;
          const head = result.split("\n")[0]?.slice(0, 100) ?? "";
          process.stdout.write(`\n${mark} ${c.gray}${summary}${c.reset}  ${c.gray}${head}${c.reset}\n`);
          printedText = false;
        },
      });
      process.stdout.write("\n\n");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`\n${c.red}✗${c.reset} ${msg}\n`);
    }
  }

  rl.close();
  console.log(`${c.gray}bye${c.reset}`);
}

/** Numbered picker for /model with no argument. */
async function pickModel(rl: Interface, choices: string[], current: string): Promise<string | null> {
  if (!choices.length) {
    console.log(`${c.yellow}no models available — check your backend${c.reset}\n`);
    return null;
  }
  choices.forEach((choice, i) => {
    const active = choice === current;
    console.log(`  ${String(i + 1).padStart(3)}. ${active ? `${c.green}${choice} ●${c.reset}` : choice}`);
  });
  const a = (await rl.question(`${c.bold}number${c.reset} (blank to cancel): `)).trim();
  if (!a) return null;
  const n = Number(a);
  if (!Number.isInteger(n) || n < 1 || n > choices.length) {
    console.log(`${c.red}not a listed number${c.reset}\n`);
    return null;
  }
  return choices[n - 1]!;
}
