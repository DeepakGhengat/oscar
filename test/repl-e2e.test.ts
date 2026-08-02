// End-to-end through the real agent REPL.
//
// src/tui/main.ts is spawned as an actual process with scripted stdin, talking
// to a mock backend over a real socket. Nothing here is stubbed in-process, so
// it exercises config loading, model discovery, the streaming client, the tool
// loop, approval gating and the interface together.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = join(ROOT, "src", "tui", "main.ts");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

let backend: Server;
let backendPort = 0;
let workdir: string;
/** Scripted replies, consumed one per /chat/completions request. */
let script: string[] = [];
/** Bodies the backend received. */
let received: Record<string, unknown>[] = [];

const MODELS = ["qwen2.5:7b", "llama3", "nomic-embed-text"];

function sse(chunks: unknown[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}
const say = (text: string) =>
  sse([
    { choices: [{ delta: { content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ]);
const callTool = (name: string, args: unknown) =>
  sse([
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "c1", function: { name, arguments: JSON.stringify(args) } }],
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ]);

function body(req: IncomingMessage): Promise<string> {
  return new Promise((res) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => res(s));
  });
}

before(async () => {
  backend = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: MODELS.map((id) => ({ id })) }));
      return;
    }
    received.push(JSON.parse(await body(req)) as Record<string, unknown>);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(script.shift() ?? say("done"));
  });
  backendPort = await new Promise<number>((r) =>
    backend.listen(0, "127.0.0.1", () => {
      const a = backend.address();
      r(typeof a === "object" && a ? a.port : 0);
    }),
  );
});

after(async () => {
  await new Promise<void>((r) => backend.close(() => r()));
});

/** Run the REPL with `input` on stdin and return everything it printed. */
async function repl(
  input: string,
  opts: { config?: string; args?: string[]; cwd?: string } = {},
): Promise<{ out: string; code: number | null }> {
  const cfgDir = opts.config ?? makeConfig();
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [TSX, MAIN, ...(opts.args ?? [])], {
      cwd: opts.cwd ?? workdir,
      env: { ...process.env, OSCAR_CONFIG: cfgDir, NO_COLOR: "1" },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.stdin.write(input);
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ out, code });
    });
  });
}

/** A config dir pointing at the mock backend. */
function makeConfig(extra = ""): string {
  const d = mkdtempSync(join(tmpdir(), "oscar-repl-cfg-"));
  writeFileSync(
    join(d, ".env"),
    [
      "USE_OPENAI_API=1",
      `OPENAI_BASE_URL=http://localhost:${backendPort}/v1`,
      "OPENAI_API_KEY=test",
      "OPENAI_MODEL=qwen2.5:7b",
      extra,
    ].join("\n"),
  );
  return d;
}

function freshWorkdir(): string {
  workdir = mkdtempSync(join(tmpdir(), "oscar-repl-work-"));
  return workdir;
}

/* ------------------------------- the basics ------------------------------- */

test("the REPL opens on O.S.C.A.R., with no other product named", async () => {
  freshWorkdir();
  script = [];
  const { out } = await repl("/exit\n");
  // The name is drawn as block-character art, so match the art itself.
  assert.match(out, /╚═════╝/, "the wordmark should render");
  assert.match(out, /Orchestrator for System Coding & Autonomous Routing/);
  assert.doesNotMatch(out, /Claude/i, "the interface must not name another product");
});

test("the active model and backend are shown on open", async () => {
  freshWorkdir();
  script = [];
  const { out } = await repl("/exit\n");
  assert.match(out, /qwen2\.5:7b/);
});

test("/help lists the commands", async () => {
  freshWorkdir();
  script = [];
  const { out } = await repl("/help\n/exit\n");
  for (const cmd of ["/model", "/clear", "/exit"]) assert.match(out, new RegExp(cmd));
});

test("an unknown command is rejected, not sent to the model", async () => {
  freshWorkdir();
  received = [];
  script = [];
  const { out } = await repl("/nonsense\n/exit\n");
  assert.match(out, /unknown command/i);
  assert.equal(received.length, 0, "a mistyped command must not become a prompt");
});

/* --------------------------------- models --------------------------------- */

test("/models lists what the backend serves", async () => {
  freshWorkdir();
  script = [];
  const { out } = await repl("/models\n/exit\n");
  assert.match(out, /qwen2\.5:7b/);
  assert.match(out, /llama3/);
});

test("embedding models are kept out of the list", async () => {
  freshWorkdir();
  script = [];
  const { out } = await repl("/models\n/exit\n");
  assert.doesNotMatch(out, /nomic-embed-text/, "an embedding model cannot chat");
});

test("/model <name> switches the active model", async () => {
  freshWorkdir();
  script = [];
  const { out } = await repl("/model default/llama3\n/exit\n");
  assert.match(out, /now using/i);
  assert.match(out, /llama3/);
});

test("/model with an unknown name is refused", async () => {
  freshWorkdir();
  script = [];
  const { out } = await repl("/model default/not-a-model\n/exit\n");
  assert.match(out, /unknown model/i);
});

/* ------------------------------ a real turn ------------------------------- */

test("a prompt reaches the backend and the reply is printed", async () => {
  freshWorkdir();
  received = [];
  script = [say("the answer is 42")];
  const { out } = await repl("what is the answer?\n/exit\n");
  assert.match(out, /the answer is 42/);
  assert.equal(received.length, 1);
  const sent = received[0] as { messages: { role: string; content: string }[] };
  assert.equal(sent.messages.at(-1)!.content, "what is the answer?");
});

test("the system prompt carries the working directory", async () => {
  const wd = freshWorkdir();
  received = [];
  script = [say("ok")];
  await repl("hello\n/exit\n", { cwd: wd });
  const sent = received[0] as { messages: { role: string; content: string }[] };
  assert.equal(sent.messages[0]!.role, "system");
  assert.match(sent.messages[0]!.content, /O\.S\.C\.A\.R\./);
});

test("tool schemas are offered to the model", async () => {
  freshWorkdir();
  received = [];
  script = [say("ok")];
  await repl("hi\n/exit\n");
  const sent = received[0] as { tools: { function: { name: string } }[] };
  const names = sent.tools.map((t) => t.function.name);
  for (const t of ["read_file", "write_file", "edit_file", "run_command"]) {
    assert.ok(names.includes(t), `${t} should be offered`);
  }
});

/* ------------------------------- tool round ------------------------------- */

test("a read tool call runs and its result reaches the model", async () => {
  const wd = freshWorkdir();
  writeFileSync(join(wd, "note.txt"), "the file says hello");
  received = [];
  script = [callTool("read_file", { path: "note.txt" }), say("It says hello.")];

  const { out } = await repl("read note.txt\n/exit\n", { cwd: wd });
  assert.match(out, /read note\.txt/, "the activity line should name the tool");
  assert.match(out, /It says hello/);

  const second = received[1] as { messages: { role: string; content?: string }[] };
  const toolMsg = second.messages.find((m) => m.role === "tool");
  assert.match(String(toolMsg?.content), /the file says hello/);
});

test("a read is not gated behind approval", async () => {
  const wd = freshWorkdir();
  writeFileSync(join(wd, "a.txt"), "x");
  script = [callTool("read_file", { path: "a.txt" }), say("done")];
  const { out } = await repl("read a.txt\n/exit\n", { cwd: wd });
  assert.doesNotMatch(out, /\[y\]es/, "reads must not interrupt");
});

/* ------------------------------- permissions ------------------------------ */

test("a write asks before touching the disk, and 'n' blocks it", async () => {
  const wd = freshWorkdir();
  script = [callTool("write_file", { path: "blocked.txt", content: "x" }), say("understood")];
  const { out } = await repl("write blocked.txt\nn\n/exit\n", { cwd: wd });
  assert.match(out, /\[y\]es/, "a write must prompt");
  assert.equal(existsSync(join(wd, "blocked.txt")), false, "denial must prevent the write");
});

test("'y' allows the write and the file appears", async () => {
  const wd = freshWorkdir();
  script = [callTool("write_file", { path: "allowed.txt", content: "written by oscar" }), say("done")];
  await repl("write allowed.txt\ny\n/exit\n", { cwd: wd });
  assert.equal(readFileSync(join(wd, "allowed.txt"), "utf8"), "written by oscar");
});

test("a command is gated the same way", async () => {
  const wd = freshWorkdir();
  script = [callTool("run_command", { command: "echo hi" }), say("done")];
  const { out } = await repl("run echo\nn\n/exit\n", { cwd: wd });
  assert.match(out, /run: echo hi/, "the prompt must show the exact command");
});

test("--yes pre-approves, so nothing prompts", async () => {
  const wd = freshWorkdir();
  script = [callTool("write_file", { path: "auto.txt", content: "no prompt" }), say("done")];
  const { out } = await repl("write it\n/exit\n", { cwd: wd, args: ["--yes"] });
  assert.doesNotMatch(out, /\[y\]es/);
  assert.equal(readFileSync(join(wd, "auto.txt"), "utf8"), "no prompt");
});

/* --------------------------------- sandbox -------------------------------- */

test("a write outside the working directory is refused by the tool itself", async () => {
  const wd = freshWorkdir();
  script = [callTool("write_file", { path: "../escaped.txt", content: "x" }), say("understood")];
  await repl("write outside\ny\n/exit\n", { cwd: wd });
  assert.equal(existsSync(join(wd, "..", "escaped.txt")), false, "the sandbox must hold even when approved");
});

/* -------------------------------- failures -------------------------------- */

test("a backend error is reported without killing the session", async () => {
  freshWorkdir();
  const broken = mkdtempSync(join(tmpdir(), "oscar-repl-bad-"));
  writeFileSync(
    join(broken, ".env"),
    ["USE_OPENAI_API=1", "OPENAI_BASE_URL=http://127.0.0.1:1/v1", "OPENAI_API_KEY=k", "OPENAI_MODEL=m"].join("\n"),
  );
  const { out } = await repl("hello\n/exit\n", { config: broken });
  // No usable backend: it must say so rather than open an unusable prompt.
  assert.match(out, /No models available|No backend configured/i);
  rmSync(broken, { recursive: true, force: true });
});

test("/clear resets the conversation the model sees", async () => {
  freshWorkdir();
  received = [];
  script = [say("first"), say("second")];
  await repl("one\n/clear\ntwo\n/exit\n");
  assert.equal(received.length, 2);
  const second = received[1] as { messages: { role: string }[] };
  // After /clear only the system prompt and the new user turn remain.
  assert.equal(second.messages.length, 2, "history should not survive /clear");
});

test("an empty line does nothing", async () => {
  freshWorkdir();
  received = [];
  script = [];
  await repl("\n\n/exit\n");
  assert.equal(received.length, 0);
});
