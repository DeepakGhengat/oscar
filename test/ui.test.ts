// Terminal rendering primitives. These look cosmetic, but a mis-measured box
// is what makes a wizard look broken — and both helpers here have already been
// fixed once for exactly that.

import { test } from "node:test";
import assert from "node:assert/strict";
import { banner, box, c } from "../src/ui.ts";

/** Strip ANSI so widths can be measured as the user sees them. */
const plain = (s: string) => s.replace(/\[[0-9;]*m/g, "");
const lines = (s: string) => plain(s).split("\n").filter((l) => l.trim() !== "");

/* --------------------------------- banner --------------------------------- */

test("banner borders line up with the title row", () => {
  // Regression: a title shorter than the 40-column floor left the closing bar
  // hanging several columns short of the corners above and below it.
  for (const title of ["x", "O.S.C.A.R. setup", "a much longer heading than the floor"]) {
    const [top, middle, bottom] = lines(banner(title));
    assert.equal(top!.length, middle!.length, `top/middle mismatch for ${JSON.stringify(title)}`);
    assert.equal(middle!.length, bottom!.length, `middle/bottom mismatch for ${JSON.stringify(title)}`);
  }
});

test("banner keeps a minimum width for short titles", () => {
  assert.ok(lines(banner("x"))[0]!.length >= 42);
});

test("banner includes the title and optional subtitle", () => {
  const out = plain(banner("Title Here", "a subtitle"));
  assert.match(out, /Title Here/);
  assert.match(out, /a subtitle/);
  assert.doesNotMatch(plain(banner("Title Here")), /a subtitle/);
});

test("banner draws a closed box", () => {
  const [top, , bottom] = lines(banner("t"));
  assert.ok(top!.startsWith("╭") && top!.endsWith("╮"));
  assert.ok(bottom!.startsWith("╰") && bottom!.endsWith("╯"));
});

/* ----------------------------------- box ---------------------------------- */

test("box width follows the longest line, and every row matches", () => {
  // Regression: a fixed cap let longer lines punch through the right border.
  const out = lines(box("short\na considerably longer line\nmid"));
  const width = out[0]!.length;
  for (const l of out) assert.equal(l.length, width, `row does not match: ${JSON.stringify(l)}`);
});

test("box contains every input line", () => {
  const out = plain(box("alpha\nbeta\ngamma"));
  for (const word of ["alpha", "beta", "gamma"]) assert.match(out, new RegExp(word));
});

test("box handles a single line and an empty line", () => {
  assert.equal(lines(box("only")).length, 3);
  assert.doesNotThrow(() => box(""));
});

test("box survives a line longer than any terminal", () => {
  const long = "x".repeat(300);
  const out = lines(box(long));
  const width = out[0]!.length;
  for (const l of out) assert.equal(l.length, width);
});

/* --------------------------------- colours -------------------------------- */

test("colour codes are strings and reset is defined", () => {
  for (const key of ["reset", "bold", "dim", "cyan", "green", "yellow", "red", "gray"]) {
    assert.equal(typeof (c as Record<string, string>)[key], "string", `${key} missing`);
  }
});

test("output is plain text when colour is disabled", () => {
  // NO_COLOR / non-TTY is the case for pipes and CI logs; escape codes there
  // are noise that ends up in transcripts.
  const rendered = banner("t");
  if (!process.stdout.isTTY || process.env.NO_COLOR) {
    assert.equal(rendered, plain(rendered), "no escape codes should be emitted");
  }
});
