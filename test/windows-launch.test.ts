// Locating and launching the CLI on Windows.
//
// `npm i -g @anthropic-ai/claude-code` writes a **claude.cmd** shim on
// Windows. There is no claude.exe unless the standalone installer or the
// desktop app put one there. The launcher used to look for claude.exe alone,
// so a perfectly good npm install failed with:
//
//     Could not launch the CLI (claude.exe): spawn claude.exe ENOENT
//
// — immediately after running the install command the same error suggested.
// A .cmd is also a script, not an executable, so CreateProcess cannot run it
// and Node needs a shell.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliExeNames, findOnPath, needsShell, quoteForShell } from "../bin/oscar.mjs";

/* ------------------------------ exe names --------------------------------- */

test("Windows looks for the npm .cmd shim, not just the .exe", () => {
  const names = cliExeNames("win32");
  assert.ok(names.includes("claude.cmd"), "claude.cmd must be searched — this is what npm installs");
  assert.ok(names.includes("claude.exe"), "claude.exe must still be searched — the desktop app ships one");
});

test("a native executable is preferred over a shim when both exist", () => {
  assert.equal(cliExeNames("win32")[0], "claude.exe");
});

test("other platforms look for the plain binary only", () => {
  assert.deepEqual(cliExeNames("linux"), ["claude"]);
  assert.deepEqual(cliExeNames("darwin"), ["claude"]);
});

/* ------------------------------ PATH lookup ------------------------------- */

function dirWith(...files: string[]): string {
  const d = mkdtempSync(join(tmpdir(), "oscar-path-"));
  for (const f of files) writeFileSync(join(d, f), "");
  return d;
}

test("a .cmd shim on PATH is found when no .exe exists", () => {
  const dir = dirWith("claude.cmd");
  const hit = findOnPath(cliExeNames("win32"), dir, "win32");
  assert.equal(hit, join(dir, "claude.cmd"));
});

test("PATH is searched in order, and every candidate name is tried per entry", () => {
  const empty = mkdtempSync(join(tmpdir(), "oscar-path-empty-"));
  const real = dirWith("claude.cmd");
  const hit = findOnPath(cliExeNames("win32"), [empty, real].join(";"), "win32");
  assert.equal(hit, join(real, "claude.cmd"));
});

test("a native .exe wins over a .cmd in the same directory", () => {
  const dir = dirWith("claude.cmd", "claude.exe");
  assert.equal(findOnPath(cliExeNames("win32"), dir, "win32"), join(dir, "claude.exe"));
});

test("quoted and blank PATH entries do not derail the search", () => {
  const dir = dirWith("claude.cmd");
  const messy = ['"C:\\does not exist"', "", "   ", dir].join(";");
  assert.equal(findOnPath(cliExeNames("win32"), messy, "win32"), join(dir, "claude.cmd"));
});

test("nothing on PATH resolves to null rather than a bogus path", () => {
  const empty = mkdtempSync(join(tmpdir(), "oscar-path-none-"));
  assert.equal(findOnPath(cliExeNames("win32"), empty, "win32"), null);
  // An empty PATH, not an absent one: omitting the argument deliberately falls
  // back to the real process PATH, which may well have a CLI on it.
  assert.equal(findOnPath(cliExeNames("linux"), "", "linux"), null);
});

test("a directory that cannot be read is skipped, not fatal", () => {
  const dir = dirWith("claude");
  const hit = findOnPath(cliExeNames("linux"), ["\0bad", dir].join(":"), "linux");
  assert.equal(hit, join(dir, "claude"));
});

/* -------------------------------- spawning -------------------------------- */

test("shim scripts need a shell; real executables do not", () => {
  assert.equal(needsShell("C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd", "win32"), true);
  assert.equal(needsShell("C:\\tools\\claude.BAT", "win32"), true);
  assert.equal(needsShell("C:\\tools\\claude.exe", "win32"), false);
});

test("a .cmd on a non-Windows platform is not shell-launched", () => {
  assert.equal(needsShell("/opt/claude.cmd", "linux"), false);
});

test("paths and arguments containing spaces survive shell quoting", () => {
  assert.equal(quoteForShell("C:\\Program Files\\claude.cmd"), '"C:\\Program Files\\claude.cmd"');
  assert.equal(quoteForShell("-p"), "-p");
  assert.equal(quoteForShell("explain this repo"), '"explain this repo"');
});

test("shell metacharacters in an argument are quoted, not interpreted", () => {
  for (const arg of ["a&b", "a|b", "a>b", "a<b", "a^b", "a(b)"]) {
    assert.equal(quoteForShell(arg), `"${arg}"`, arg);
  }
});

test("an embedded quote is escaped rather than terminating the argument", () => {
  assert.equal(quoteForShell('say "hi"'), '"say \\"hi\\""');
});

/* ------------------------- the exact reported failure --------------------- */

test("regression: an npm-installed CLI on Windows resolves and is shell-launched", () => {
  // Reproduces the user's machine: npm put claude.cmd in %APPDATA%\npm,
  // and there is no claude.exe anywhere.
  const npmBin = mkdtempSync(join(tmpdir(), "oscar-npmbin-"));
  mkdirSync(join(npmBin, "node_modules"), { recursive: true });
  writeFileSync(join(npmBin, "claude.cmd"), "@echo off\r\n");

  const resolved = findOnPath(cliExeNames("win32"), npmBin, "win32");
  assert.equal(resolved, join(npmBin, "claude.cmd"), "must resolve the npm shim");
  assert.equal(needsShell(resolved!, "win32"), true, "must launch it through a shell");
});
