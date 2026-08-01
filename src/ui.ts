// Tiny zero-dependency terminal UI helpers (ANSI). Matches the feel of
// OpenClaude's welcome screen — banner, boxed select, dim descriptions —
// without pulling React/Ink/chalk into a small proxy launcher.

const isTTY = process.stdout.isTTY && !process.env.NO_COLOR;
const ansi = (code: string) => (isTTY ? `\x1b[${code}m` : "");

export const c = {
  reset: ansi("0"),
  bold: ansi("1"),
  dim: ansi("2"),
  cyan: ansi("36"),
  green: ansi("32"),
  yellow: ansi("33"),
  red: ansi("31"),
  magenta: ansi("35"),
  gray: ansi("90"),
};

/** A centered-ish banner with a tagline, like OpenClaude's first-run header. */
export function banner(title: string, subtitle?: string): string {
  const line = "─".repeat(Math.max(title.length + 4, 40));
  return (
    `\n${c.cyan}${c.bold}╭${line}╮\n` +
    `│  ${title}  │\n` +
    `╰${line}╯${c.reset}` +
    (subtitle ? `\n${c.gray}${subtitle}${c.reset}\n` : "") +
    "\n"
  );
}

/** A rounded box around any block of text. */
export function box(text: string): string {
  const lines = text.split(/\r?\n/);
  const width = Math.min(60, Math.max(...lines.map((l) => l.length)) + 2);
  const top = `${c.cyan}╭${"─".repeat(width)}╮${c.reset}`;
  const bottom = `${c.cyan}╰${"─".repeat(width)}╯${c.reset}`;
  const body = lines
    .map((l) => `${c.cyan}│${c.reset} ${l}${" ".repeat(Math.max(0, width - 1 - l.length))}${c.cyan}│${c.reset}`)
    .join("\n");
  return [top, body, bottom].join("\n");
}

/**
 * A readline-question function that works on BOTH TTY and piped/non-TTY stdin.
 *
 * `rl.question()` on Node hangs on the SECOND and subsequent calls when stdin
 * is a pipe. We work around this by buffering piped stdin ourselves: read the
 * whole stream once into a line queue and pop lines off it. On TTY stdin we
 * delegate to `rl.question()` normally.
 */
export type QuestionFn = (prompt: string) => Promise<string>;

let pipedQueue: string[] | null = null;
let pipedResolveReady: (() => void) | null = null;
let pipedReady: Promise<void> | null = null;

function ensurePipedQueue(): Promise<string[]> {
  if (pipedQueue) return Promise.resolve(pipedQueue);
  pipedQueue = [];
  pipedReady = new Promise<void>((resolve) => { pipedResolveReady = resolve; });
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      pipedQueue!.push(buf.slice(0, idx).replace(/\r$/, ""));
      buf = buf.slice(idx + 1);
    }
  });
  process.stdin.on("end", () => {
    if (buf.length) pipedQueue!.push(buf);
    pipedResolveReady!();
  });
  // If stdin is already closed (no data), resolve on next tick.
  process.stdin.on("close", () => pipedResolveReady!());
  return pipedReady!.then(() => pipedQueue!);
}

export function createQuestion(
  rl: ReturnType<typeof import("node:readline/promises").createInterface>,
): QuestionFn {
  return async (prompt: string): Promise<string> => {
    process.stdout.write(prompt);
    if (process.stdin.isTTY) {
      return new Promise<string>((resolve) => {
        const handler = (line: string): void => {
          rl.off("line", handler);
          resolve(line);
        };
        rl.on("line", handler);
      });
    }
    const queue = await ensurePipedQueue();
    return queue.shift() ?? "";
  };
}

/** Print a numbered select menu. Returns the chosen index (0-based). */
export interface SelectOption {
  label: string;
  description?: string;
}

export async function select(
  rl: ReturnType<typeof import("node:readline/promises").createInterface>,
  options: SelectOption[],
  prompt: string,
): Promise<number> {
  const ask = createQuestion(rl);
  for (;;) {
    options.forEach((o, i) => {
      const num = `${c.cyan}${i + 1}${c.reset})`;
      const desc = o.description ? `  ${c.gray}${o.description}${c.reset}` : "";
      console.log(`  ${num} ${o.label}${desc}`);
    });
    const a = (await ask(`${c.bold}${prompt}${c.reset}: `)).trim();
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
    console.log(`${c.red}  invalid choice, try again${c.reset}`);
  }
}