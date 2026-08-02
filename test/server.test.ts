// The HTTP surface of src/server.ts, driven end to end.
//
// server.ts calls listen() at module scope, so it can't be imported — it is
// spawned as a real child process (exactly how the launcher runs it) against a
// mock OpenAI backend and a mock "real Anthropic" for the passthrough leg.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BACKEND_MODELS = ["glm-5.2:cloud", "qwen2.5:7b", "nomic-embed-text:v1.5"];

let backend: Server;
let anthropic: Server;
let proxy: ChildProcess;
let proxyPort = 0;
let configDir = "";
/** Paths the mock Anthropic saw — proves what was forwarded vs handled locally. */
let anthropicHits: string[] = [];

function listen(server: Server): Promise<number> {
  return new Promise((r) =>
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      r(typeof a === "object" && a ? a.port : 0);
    }),
  );
}

function readBuf(req: IncomingMessage): Promise<Buffer> {
  return new Promise((res, rej) => {
    const c: Buffer[] = [];
    req.on("data", (b: Buffer) => c.push(b));
    req.on("end", () => res(Buffer.concat(c)));
    req.on("error", rej);
  });
}

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": buf.length });
  res.end(buf);
}

/** Find a free port by opening and immediately closing a listener. */
async function freePort(): Promise<number> {
  const s = createServer();
  const p = await listen(s);
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

async function waitForHealth(port: number): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${port}/healthz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("proxy never became healthy");
}

before(async () => {
  backend = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      sendJSON(res, 200, { object: "list", data: BACKEND_MODELS.map((id) => ({ id })) });
      return;
    }
    if (url.pathname.endsWith("/chat/completions")) {
      const body = JSON.parse((await readBuf(req)).toString("utf8")) as { model: string };
      sendJSON(res, 200, {
        id: "chatcmpl-mock",
        model: body.model,
        // Echo the model back so the test can assert what was actually called.
        choices: [
          { index: 0, message: { role: "assistant", content: body.model }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  const backendPort = await listen(backend);

  anthropic = createServer(async (req, res) => {
    anthropicHits.push(new URL(req.url ?? "/", "http://localhost").pathname);
    await readBuf(req);
    sendJSON(res, 200, { forwarded: true });
  });
  const anthropicPort = await listen(anthropic);

  configDir = mkdtempSync(join(tmpdir(), "oscar-server-"));
  writeFileSync(
    join(configDir, ".env"),
    [
      "USE_OPENAI_API=1",
      "OPENAI_API_KEY=sk-test",
      "OPENAI_MODEL=qwen2.5:7b",
      `OPENAI_BASE_URL=http://localhost:${backendPort}/v1`,
      "",
    ].join("\n"),
  );

  proxyPort = await freePort();
  proxy = spawn(process.execPath, [join(ROOT, "node_modules/tsx/dist/cli.mjs"), join(ROOT, "src/server.ts")], {
    cwd: ROOT,
    stdio: "ignore",
    env: {
      ...process.env,
      OSCAR_CONFIG: configDir,
      PROXY_PORT: String(proxyPort),
      USE_OPENAI_API: "1",
      OPENAI_API_KEY: "sk-test",
      OPENAI_MODEL: "qwen2.5:7b",
      OPENAI_BASE_URL: `http://localhost:${backendPort}/v1`,
      OSCAR_UPSTREAM_BASE_URL: `http://localhost:${anthropicPort}`,
      OSCAR_MAX_OUTPUT_TOKENS: "",
    },
  });
  await waitForHealth(proxyPort);
});

after(async () => {
  proxy?.kill();
  await Promise.all(
    [backend, anthropic].map((s) => new Promise<void>((r) => s?.close(() => r()))),
  );
  rmSync(configDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const url = (p: string) => `http://localhost:${proxyPort}${p}`;

/* --------------------------------- health --------------------------------- */

test("GET /healthz reports the active route and backend", async () => {
  const r = await fetch(url("/healthz"));
  assert.equal(r.status, 200);
  const body = (await r.json()) as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal(body.route, "openai");
  assert.equal(body.port, proxyPort);
});

test("GET / is an alias for the health probe", async () => {
  assert.equal((await fetch(url("/"))).status, 200);
});

/* ---------------------------- model discovery ----------------------------- */

test("GET /v1/models advertises aliases the CLI will not filter out", async () => {
  const r = await fetch(url("/v1/models?limit=1000"));
  assert.equal(r.status, 200);
  const body = (await r.json()) as { object: string; has_more: boolean; data: { id: string; display_name: string }[] };
  assert.equal(body.object, "list");
  assert.equal(body.has_more, false);
  for (const m of body.data) assert.match(m.id, /^(claude|anthropic)/i);
  assert.deepEqual(body.data.map((m) => m.display_name).sort(), ["glm-5.2:cloud", "qwen2.5:7b"]);
});

test("the embedding model never reaches the picker", async () => {
  const body = (await (await fetch(url("/v1/models"))).json()) as { data: { display_name: string }[] };
  assert.ok(!body.data.some((m) => m.display_name.includes("embed")));
});

test("/v1/models is answered locally, never forwarded to Anthropic", async () => {
  anthropicHits = [];
  await fetch(url("/v1/models"));
  assert.deepEqual(anthropicHits, []);
});

/* ------------------------------ token counting ---------------------------- */

test("POST /v1/messages/count_tokens is answered locally", async () => {
  anthropicHits = [];
  const r = await fetch(url("/v1/messages/count_tokens"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hello world" }],
    }),
  });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { input_tokens: number };
  assert.ok(body.input_tokens > 0);
  assert.deepEqual(anthropicHits, [], "forwarding this 401s on the dummy key");
});

test("count_tokens rejects a malformed body with 400, not 500", async () => {
  const r = await fetch(url("/v1/messages/count_tokens"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(r.status, 400);
});

/* ------------------------------- messages --------------------------------- */

test("POST /v1/messages routes to the backend and returns Anthropic shape", async () => {
  const r = await fetch(url("/v1/messages"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { type: string; content: { type: string; text: string }[] };
  assert.equal(body.type, "message");
  // The mock echoes the model it was called with: an Anthropic tier id must
  // fall back to OPENAI_MODEL.
  assert.equal(body.content[0]!.text, "qwen2.5:7b");
});

test("a picked alias overrides OPENAI_MODEL for that request", async () => {
  const list = (await (await fetch(url("/v1/models"))).json()) as {
    data: { id: string; display_name: string }[];
  };
  const glm = list.data.find((m) => m.display_name === "glm-5.2:cloud")!;
  const r = await fetch(url("/v1/messages"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: glm.id, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
  });
  const body = (await r.json()) as { content: { text: string }[] };
  assert.equal(body.content[0]!.text, "glm-5.2:cloud");
});

/* --------------------------- control endpoints ---------------------------- */

test("GET /_oscar/status reports the current model with the key redacted", async () => {
  const r = await fetch(url("/_oscar/status"));
  assert.equal(r.status, 200);
  const body = (await r.json()) as { openaiModel: string; openaiKey: string };
  assert.equal(body.openaiModel, "qwen2.5:7b");
  assert.ok(!body.openaiKey.includes("sk-test"), "the full key must not be echoed back");
});

test("GET /_oscar/models lists raw backend ids, sorted", async () => {
  const r = await fetch(url("/_oscar/models"));
  assert.equal(r.status, 200);
  const body = (await r.json()) as { current: string; models: string[] };
  assert.equal(body.current, "qwen2.5:7b");
  assert.deepEqual(body.models, [...body.models].sort());
  assert.ok(body.models.includes("glm-5.2:cloud"));
});

test("POST /_oscar/model hot-swaps the model and persists it", async () => {
  const r = await fetch(url("/_oscar/model"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "glm-5.2:cloud" }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, openaiModel: "glm-5.2:cloud" });

  // Visible to the running proxy without a restart...
  const status = (await (await fetch(url("/_oscar/status"))).json()) as { openaiModel: string };
  assert.equal(status.openaiModel, "glm-5.2:cloud");

  // ...and written through to .env so it survives one.
  assert.match(readFileSync(join(configDir, ".env"), "utf8"), /^OPENAI_MODEL=glm-5\.2:cloud$/m);

  // A request with no explicit model now uses it.
  const msg = await fetch(url("/v1/messages"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
  });
  const body = (await msg.json()) as { content: { text: string }[] };
  assert.equal(body.content[0]!.text, "glm-5.2:cloud");

  // Restore for any later test.
  await fetch(url("/_oscar/model"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "qwen2.5:7b" }),
  });
});

test("POST /_oscar/model validates its input", async () => {
  const missing = await fetch(url("/_oscar/model"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(missing.status, 400);

  const blank = await fetch(url("/_oscar/model"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "   " }),
  });
  assert.equal(blank.status, 400);

  const bad = await fetch(url("/_oscar/model"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{oops",
  });
  assert.equal(bad.status, 400);
});

test("an unknown /_oscar/ endpoint 404s instead of falling through to Anthropic", async () => {
  anthropicHits = [];
  const r = await fetch(url("/_oscar/nope"));
  assert.equal(r.status, 404);
  assert.deepEqual(anthropicHits, []);
});

/* -------------------------------- fallback -------------------------------- */

test("unrecognised paths are forwarded to the real Anthropic endpoint", async () => {
  anthropicHits = [];
  const r = await fetch(url("/v1/organizations/whoami"));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { forwarded: true });
  assert.deepEqual(anthropicHits, ["/v1/organizations/whoami"]);
});
