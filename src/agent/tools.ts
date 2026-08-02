// The tools the agent can call.
//
// Each one declares a JSON schema for the model, a risk level for the
// permission layer, and a run() that returns text the model reads back. Tools
// return errors as strings rather than throwing: a failed tool call is
// information the model should act on, not a crash.

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import type { ToolSchema } from "./client.ts";

export type Risk = "safe" | "write" | "execute";

export interface Tool extends ToolSchema {
  risk: Risk;
  /** One line shown in the permission prompt and the activity log. */
  summarise: (args: Record<string, unknown>) => string;
  run: (args: Record<string, unknown>, cwd: string) => Promise<string>;
}

const MAX_OUTPUT = 30_000;

function clip(s: string, limit = MAX_OUTPUT): string {
  return s.length > limit ? `${s.slice(0, limit)}\n… [truncated, ${s.length} chars total]` : s;
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : "";
}

/** Resolve a tool-supplied path, refusing to escape the working directory.
 *
 * The model is not a trusted input source: a path from it can be absolute, or
 * climb out with `..`. Confining writes and reads to the project keeps a
 * confused model from wandering into the rest of the filesystem. */
export function safeResolve(cwd: string, p: string): { ok: true; path: string } | { ok: false; error: string } {
  if (!p) return { ok: false, error: "no path given" };
  const full = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  const rel = relative(resolve(cwd), full);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { ok: false, error: `path is outside the working directory: ${p}` };
  }
  return { ok: true, path: full };
}

/* --------------------------------- read ----------------------------------- */

const readTool: Tool = {
  name: "read_file",
  description:
    "Read a text file from the working directory. Returns the contents with line numbers. Use before editing anything.",
  risk: "safe",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the working directory" },
    },
    required: ["path"],
  },
  summarise: (a) => `read ${str(a, "path")}`,
  async run(args, cwd) {
    const r = safeResolve(cwd, str(args, "path"));
    if (!r.ok) return `Error: ${r.error}`;
    if (!existsSync(r.path)) return `Error: no such file: ${str(args, "path")}`;
    if (statSync(r.path).isDirectory()) return `Error: that is a directory, not a file`;
    const body = readFileSync(r.path, "utf8");
    const numbered = body
      .split("\n")
      .map((l, i) => `${String(i + 1).padStart(5)}  ${l}`)
      .join("\n");
    return clip(numbered);
  },
};

/* --------------------------------- write ---------------------------------- */

const writeTool: Tool = {
  name: "write_file",
  description:
    "Write a file, creating it or replacing its entire contents. Prefer edit_file for changing part of an existing file.",
  risk: "write",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the working directory" },
      content: { type: "string", description: "The complete new contents" },
    },
    required: ["path", "content"],
  },
  summarise: (a) => `write ${str(a, "path")} (${str(a, "content").split("\n").length} lines)`,
  async run(args, cwd) {
    const r = safeResolve(cwd, str(args, "path"));
    if (!r.ok) return `Error: ${r.error}`;
    mkdirSync(dirname(r.path), { recursive: true });
    writeFileSync(r.path, str(args, "content"));
    return `Wrote ${str(args, "path")}`;
  },
};

/* --------------------------------- edit ----------------------------------- */

const editTool: Tool = {
  name: "edit_file",
  description:
    "Replace an exact string in a file. The old string must appear exactly once — include surrounding context to make it unique.",
  risk: "write",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string", description: "Exact text to replace, unique in the file" },
      new_string: { type: "string", description: "Replacement text" },
    },
    required: ["path", "old_string", "new_string"],
  },
  summarise: (a) => `edit ${str(a, "path")}`,
  async run(args, cwd) {
    const r = safeResolve(cwd, str(args, "path"));
    if (!r.ok) return `Error: ${r.error}`;
    if (!existsSync(r.path)) return `Error: no such file: ${str(args, "path")}`;
    const body = readFileSync(r.path, "utf8");
    const oldStr = str(args, "old_string");
    if (!oldStr) return `Error: old_string is empty`;
    const count = body.split(oldStr).length - 1;
    if (count === 0) return `Error: old_string not found in ${str(args, "path")}`;
    if (count > 1) {
      return `Error: old_string appears ${count} times; include more context so it is unique`;
    }
    writeFileSync(r.path, body.replace(oldStr, str(args, "new_string")));
    return `Edited ${str(args, "path")}`;
  },
};

/* --------------------------------- list ----------------------------------- */

const globTool: Tool = {
  name: "find_files",
  description: "List files matching a glob pattern, e.g. 'src/**/*.ts'. Use to explore the project.",
  risk: "safe",
  parameters: {
    type: "object",
    properties: { pattern: { type: "string", description: "Glob pattern" } },
    required: ["pattern"],
  },
  summarise: (a) => `find ${str(a, "pattern")}`,
  async run(args, cwd) {
    const { glob } = await import("node:fs/promises");
    const pattern = str(args, "pattern") || "**/*";
    const out: string[] = [];
    try {
      for await (const entry of glob(pattern, { cwd, exclude: (p) => /node_modules|\.git/.test(p) })) {
        out.push(String(entry));
        if (out.length >= 500) break;
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    return out.length ? clip(out.sort().join("\n")) : "No files matched.";
  },
};

/* --------------------------------- search --------------------------------- */

const grepTool: Tool = {
  name: "search_files",
  description: "Search file contents with a regular expression. Returns matching lines with their file and line number.",
  risk: "safe",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression" },
      glob: { type: "string", description: "Optional file filter, e.g. '**/*.ts'" },
    },
    required: ["pattern"],
  },
  summarise: (a) => `search /${str(a, "pattern")}/`,
  async run(args, cwd) {
    const { glob } = await import("node:fs/promises");
    let re: RegExp;
    try {
      re = new RegExp(str(args, "pattern"), "i");
    } catch (err) {
      return `Error: bad regular expression: ${err instanceof Error ? err.message : err}`;
    }
    const hits: string[] = [];
    try {
      for await (const entry of glob(str(args, "glob") || "**/*", {
        cwd,
        exclude: (p) => /node_modules|\.git|\.png$|\.jpg$|\.gif$|\.pdf$|\.zip$/.test(p),
      })) {
        const r = safeResolve(cwd, String(entry));
        if (!r.ok || !existsSync(r.path) || statSync(r.path).isDirectory()) continue;
        let body: string;
        try {
          body = readFileSync(r.path, "utf8");
        } catch {
          continue;
        }
        body.split("\n").forEach((line, i) => {
          if (hits.length < 200 && re.test(line)) hits.push(`${entry}:${i + 1}: ${line.trim().slice(0, 200)}`);
        });
        if (hits.length >= 200) break;
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    return hits.length ? clip(hits.join("\n")) : "No matches.";
  },
};

/* --------------------------------- bash ----------------------------------- */

const bashTool: Tool = {
  name: "run_command",
  description:
    "Run a shell command in the working directory and return its output. Use for builds, tests, git, and package managers.",
  risk: "execute",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line to run" },
      timeout_ms: { type: "number", description: "Optional timeout, default 120000" },
    },
    required: ["command"],
  },
  summarise: (a) => `run: ${str(a, "command")}`,
  async run(args, cwd) {
    const command = str(args, "command");
    if (!command) return "Error: no command given";
    const timeout = typeof args.timeout_ms === "number" ? args.timeout_ms : 120_000;

    return new Promise<string>((resolvePromise) => {
      const child = spawn(command, { cwd, shell: true, env: process.env });
      let out = "";
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill();
      }, timeout);

      child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
      child.on("error", (err) => {
        clearTimeout(timer);
        resolvePromise(`Error: ${err.message}`);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const status = killed ? `timed out after ${timeout}ms` : `exit code ${code}`;
        resolvePromise(clip(`[${status}]\n${out.trim() || "(no output)"}`));
      });
    });
  },
};

export const TOOLS: Tool[] = [readTool, writeTool, editTool, globTool, grepTool, bashTool];

export function toolByName(name: string): Tool | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** The schemas handed to the model — risk and run() stay on our side. */
export function toolSchemas(): ToolSchema[] {
  return TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));
}
