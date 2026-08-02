// `oscar --profiles` and `oscar --use <name>`.

import { c, banner } from "./ui.ts";
import { activateProfile, configDir, listProfiles, profilesDir } from "./profiles.ts";

function show(): number {
  const profiles = listProfiles();
  console.log(banner("Saved profiles", profilesDir()));
  if (!profiles.length) {
    console.log(`${c.dim}None saved yet. Each ${c.reset}oscar --setup${c.dim} saves one automatically.${c.reset}\n`);
    return 0;
  }
  const width = Math.max(...profiles.map((p) => p.name.length));
  for (const p of profiles) {
    const mark = p.active ? `${c.green}●${c.reset}` : " ";
    console.log(`  ${mark} ${c.bold}${p.name.padEnd(width)}${c.reset}  ${c.dim}${p.summary}${c.reset}`);
  }
  console.log(`\n${c.dim}Switch with: ${c.reset}oscar --use <name>${c.reset}\n`);
  return 0;
}

function use(name: string | undefined): number {
  if (!name || name.startsWith("--")) {
    console.error(`Usage: ${c.bold}oscar --use <name>${c.reset}\n`);
    show();
    return 1;
  }
  const result = activateProfile(name);
  if (!result.ok) {
    console.error(`${c.red}✗${c.reset} ${result.error}`);
    return 1;
  }
  console.log(`${c.green}✓${c.reset} switched to ${c.bold}${name}${c.reset} — ${result.summary}`);
  console.log(`${c.dim}config: ${configDir()}/.env${c.reset}`);
  console.log(`\n${c.dim}Run it with: ${c.reset}oscar`);
  return 0;
}

export function main(argv: string[]): number {
  const i = argv.indexOf("--use");
  if (i >= 0) return use(argv[i + 1]);
  return show();
}

const invokedAs = process.argv[1] ?? "";
if (invokedAs.endsWith("profilecmd.ts") || invokedAs.endsWith("profilecmd.mjs")) {
  process.exitCode = main(process.argv.slice(2));
}
