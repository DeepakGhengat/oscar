// The agent's tools. These write to disk and run commands, so the sandboxing
// and failure behaviour matter more than the happy paths.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeResolve, toolByName, toolSchemas, TOOLS } from "../src/agent/tools.ts";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "oscar-tools-"));
});

afterEach(() => {
  try {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* cosmetic */
  }
});

const run = (name: string, args: Record<string, unknown>) => toolByName(name)!.run(args, cwd);

/* ------------------------------- sandboxing ------------------------------- */

test("a path escaping the working directory is refused", () => {
  // The model is not a trusted input source.
  for (const p of ["../outside.txt", "../../etc/passwd", "a/../../b"]) {
    const r = safeResolve(cwd, p);
    assert.equal(r.ok, false, `${p} should be refused`);
  }
});

test("an absolute path outside the working directory is refused", () => {
  const r = safeResolve(cwd, process.platform === "win32" ? "C:\\Windows\\system.ini" : "/etc/passwd");
  assert.equal(r.ok, false);
});

test("paths inside the working directory are allowed", () => {
  for (const p of ["a.txt", "src/b.ts", "./c.md"]) {
    assert.equal(safeResolve(cwd, p).ok, true, `${p} should be allowed`);
  }
});

test("write_file cannot escape the sandbox", async () => {
  const out = await run("write_file", { path: "../escaped.txt", content: "x" });
  assert.match(out, /outside the working directory/);
});

/* ---------------------------------- read ---------------------------------- */

test("read_file returns numbered lines", async () => {
  writeFileSync(join(cwd, "a.txt"), "first\nsecond");
  const out = await run("read_file", { path: "a.txt" });
  assert.match(out, /1 {2}first/);
  assert.match(out, /2 {2}second/);
});

test("read_file reports a missing file instead of throwing", async () => {
  assert.match(await run("read_file", { path: "nope.txt" }), /^Error: no such file/);
});

test("read_file refuses a directory", async () => {
  mkdirSync(join(cwd, "sub"));
  assert.match(await run("read_file", { path: "sub" }), /directory, not a file/);
});

/* --------------------------------- write ---------------------------------- */

test("write_file creates missing parent directories", async () => {
  const out = await run("write_file", { path: "deep/nested/a.txt", content: "hi" });
  assert.match(out, /^Wrote/);
  assert.equal(readFileSync(join(cwd, "deep/nested/a.txt"), "utf8"), "hi");
});

/* ---------------------------------- edit ---------------------------------- */

test("edit_file replaces an exact unique string", async () => {
  writeFileSync(join(cwd, "a.ts"), "const x = 1;\nconst y = 2;\n");
  const out = await run("edit_file", { path: "a.ts", old_string: "const x = 1;", new_string: "const x = 42;" });
  assert.match(out, /^Edited/);
  assert.match(readFileSync(join(cwd, "a.ts"), "utf8"), /const x = 42;/);
});

test("edit_file refuses an ambiguous match rather than guessing", async () => {
  // Replacing the wrong one of several identical lines is silent corruption.
  writeFileSync(join(cwd, "a.ts"), "dup\ndup\n");
  const out = await run("edit_file", { path: "a.ts", old_string: "dup", new_string: "x" });
  assert.match(out, /appears 2 times/);
  assert.equal(readFileSync(join(cwd, "a.ts"), "utf8"), "dup\ndup\n", "file must be untouched");
});

test("edit_file reports a string that is not present", async () => {
  writeFileSync(join(cwd, "a.ts"), "hello\n");
  assert.match(await run("edit_file", { path: "a.ts", old_string: "absent", new_string: "x" }), /not found/);
});

test("edit_file rejects an empty old_string", async () => {
  writeFileSync(join(cwd, "a.ts"), "hello\n");
  assert.match(await run("edit_file", { path: "a.ts", old_string: "", new_string: "x" }), /empty/);
});

/* --------------------------------- search --------------------------------- */

test("search_files finds matching lines with file and line number", async () => {
  writeFileSync(join(cwd, "a.ts"), "const target = 1;\nother\n");
  const out = await run("search_files", { pattern: "target" });
  assert.match(out, /a\.ts:1:/);
});

test("search_files reports a bad regular expression", async () => {
  assert.match(await run("search_files", { pattern: "([" }), /bad regular expression/);
});

test("search_files says so when nothing matches", async () => {
  writeFileSync(join(cwd, "a.ts"), "nothing here\n");
  assert.equal(await run("search_files", { pattern: "zzzz" }), "No matches.");
});

/* ---------------------------------- find ---------------------------------- */

test("find_files lists matches for a glob", async () => {
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src/a.ts"), "");
  writeFileSync(join(cwd, "src/b.ts"), "");
  const out = await run("find_files", { pattern: "src/*.ts" });
  assert.match(out, /a\.ts/);
  assert.match(out, /b\.ts/);
});

/* -------------------------------- command --------------------------------- */

test("run_command returns output and exit status", async () => {
  const out = await run("run_command", { command: "echo hello-from-oscar" });
  assert.match(out, /hello-from-oscar/);
  assert.match(out, /exit code 0/);
});

test("run_command surfaces a non-zero exit rather than hiding it", async () => {
  const out = await run("run_command", { command: "exit 3" });
  assert.match(out, /exit code 3/);
});

test("run_command reports an empty command", async () => {
  assert.match(await run("run_command", { command: "" }), /no command given/);
});

/* -------------------------------- schemas --------------------------------- */

test("every tool exposes a valid schema to the model", () => {
  const schemas = toolSchemas();
  assert.equal(schemas.length, TOOLS.length);
  for (const s of schemas) {
    assert.ok(s.name, "a tool needs a name");
    assert.ok(s.description.length > 20, `${s.name} needs a usable description`);
    assert.equal((s.parameters as { type?: string }).type, "object");
  }
});

test("schemas carry no internal fields", () => {
  // risk/run/summarise are ours; leaking them would confuse the model.
  for (const s of toolSchemas() as unknown as Record<string, unknown>[]) {
    assert.deepEqual(Object.keys(s).sort(), ["description", "name", "parameters"]);
  }
});

test("every tool declares a risk level", () => {
  for (const t of TOOLS) {
    assert.ok(["safe", "write", "execute"].includes(t.risk), `${t.name} has no valid risk`);
  }
});

test("writes and commands are never classed as safe", () => {
  // The permission layer gates on this; a mislabelled tool runs unprompted.
  assert.equal(toolByName("write_file")!.risk, "write");
  assert.equal(toolByName("edit_file")!.risk, "write");
  assert.equal(toolByName("run_command")!.risk, "execute");
  assert.equal(toolByName("read_file")!.risk, "safe");
});

test("summaries are human-readable for the approval prompt", () => {
  assert.match(toolByName("run_command")!.summarise({ command: "npm test" }), /npm test/);
  assert.match(toolByName("edit_file")!.summarise({ path: "src/a.ts" }), /src\/a\.ts/);
});
