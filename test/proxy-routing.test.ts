// routeMessageRequest: model resolution, upstream failures, and the header
// handling on the Anthropic passthrough leg.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { routeMessageRequest } from "../src/proxy.ts";
import { clearCatalogCache } from "../src/catalog.ts";

const KEYS = [
  "USE_OPENAI_API",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "OPENAI_BASE_URL",
  "CCF_MAX_OUTPUT_TOKENS",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_REAL_BASE_URL",
];
let saved: Record<string, string | undefined> = {};
const servers: Server[] = [];

/** Last /chat/completions body the mock backend received. */
let lastUpstream: Record<string, unknown> | null = null;
/** Headers the mock "real Anthropic" received on the passthrough leg. */
let lastPassthroughHeaders: Record<string, string | string[] | undefined> = {};

function listen(s: Server): Promise<number> {
  servers.push(s);
  return new Promise((r) =>
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
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

function json(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": buf.length });
  res.end(buf);
}

/** Mock OpenAI backend. `chat` decides the /chat/completions outcome. */
async function startBackend(
  chat: (body: Record<string, unknown>) => { status: number; body: unknown },
  models: string[] = ["glm-5.2:cloud", "qwen2.5:7b"],
): Promise<number> {
  return listen(
    createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname.endsWith("/models")) {
        json(res, 200, { data: models.map((id) => ({ id })) });
        return;
      }
      lastUpstream = JSON.parse((await readBuf(req)).toString("utf8")) as Record<string, unknown>;
      const r = chat(lastUpstream);
      json(res, r.status, r.body);
    }),
  );
}

const OK = () => ({
  status: 200,
  body: {
    id: "c1",
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
});

const body = (model: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ model, max_tokens: 100, messages: [{ role: "user", content: "hi" }], ...extra });

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  lastUpstream = null;
  lastPassthroughHeaders = {};
  clearCatalogCache();
});

afterEach(async () => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  clearCatalogCache();
});

async function useBackend(
  chat: (b: Record<string, unknown>) => { status: number; body: unknown } = OK,
  models?: string[],
): Promise<void> {
  const port = await startBackend(chat, models);
  process.env.USE_OPENAI_API = "1";
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.OPENAI_MODEL = "qwen2.5:7b";
  process.env.OPENAI_BASE_URL = `http://localhost:${port}/v1`;
}

/* ---------------------------- model resolution ---------------------------- */

test("an Anthropic tier id falls back to OPENAI_MODEL", async () => {
  await useBackend();
  const r = await routeMessageRequest(body("claude-sonnet-4-5"), new Headers());
  assert.equal(r.route, "openai");
  assert.equal(r.upstreamModel, "qwen2.5:7b");
  assert.equal(lastUpstream!.model, "qwen2.5:7b");
});

test("an advertised alias overrides OPENAI_MODEL", async () => {
  await useBackend();
  const r = await routeMessageRequest(body("claude-ccf-glm-5.2-cloud"), new Headers());
  assert.equal(r.upstreamModel, "glm-5.2:cloud");
  assert.equal(lastUpstream!.model, "glm-5.2:cloud");
});

test("an alias for an unknown model falls back rather than 404ing upstream", async () => {
  await useBackend();
  const r = await routeMessageRequest(body("claude-ccf-model-that-left"), new Headers());
  assert.equal(r.upstreamModel, "qwen2.5:7b");
});

test("the reported incoming model is what the caller sent", async () => {
  await useBackend();
  const r = await routeMessageRequest(body("claude-ccf-glm-5.2-cloud"), new Headers());
  assert.equal(r.incomingModel, "claude-ccf-glm-5.2-cloud");
});

test("routing still works when the model list is unreachable", async () => {
  // Backend up for chat, but /models 500s — requests must not break.
  const port = await listen(
    createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname.endsWith("/models")) {
        res.writeHead(500);
        res.end("down");
        return;
      }
      lastUpstream = JSON.parse((await readBuf(req)).toString("utf8")) as Record<string, unknown>;
      json(res, 200, OK().body);
    }),
  );
  process.env.USE_OPENAI_API = "1";
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.OPENAI_MODEL = "qwen2.5:7b";
  process.env.OPENAI_BASE_URL = `http://localhost:${port}/v1`;

  const r = await routeMessageRequest(body("claude-sonnet-4-5"), new Headers());
  assert.equal(r.response.status, 200);
  assert.equal(lastUpstream!.model, "qwen2.5:7b");
});

/* ------------------------------- clamping --------------------------------- */

test("CCF_MAX_OUTPUT_TOKENS reaches the upstream request", async () => {
  await useBackend();
  process.env.CCF_MAX_OUTPUT_TOKENS = "64";
  await routeMessageRequest(body("claude-sonnet-4-5", { max_tokens: 32000 }), new Headers());
  assert.equal(lastUpstream!.max_tokens, 64);
  assert.equal(lastUpstream!.max_completion_tokens, 64);
});

/* ---------------------------- upstream failures --------------------------- */

test("an upstream error is surfaced verbatim, not swallowed", async () => {
  await useBackend(() => ({
    status: 402,
    body: { error: { message: "insufficient credits" } },
  }));
  const r = await routeMessageRequest(body("claude-sonnet-4-5"), new Headers());
  assert.equal(r.response.status, 402);
  const text = await r.response.text();
  assert.match(text, /insufficient credits/, "the user needs to see why the call failed");
});

test("a 429 keeps its status so the CLI can back off", async () => {
  await useBackend(() => ({ status: 429, body: { error: { message: "rate limited" } } }));
  assert.equal((await routeMessageRequest(body("claude-sonnet-4-5"), new Headers())).response.status, 429);
});

test("an unreachable backend rejects rather than returning a bogus 200", async () => {
  process.env.USE_OPENAI_API = "1";
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.OPENAI_MODEL = "m";
  // Port 1 is reserved and refuses connections.
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:1/v1";
  await assert.rejects(() => routeMessageRequest(body("claude-sonnet-4-5"), new Headers()));
});

/* -------------------------------- streaming ------------------------------- */

test("a streaming request produces an Anthropic SSE response", async () => {
  const port = await listen(
    createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname.endsWith("/models")) {
        json(res, 200, { data: [] });
        return;
      }
      await readBuf(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }),
  );
  process.env.USE_OPENAI_API = "1";
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.OPENAI_MODEL = "m";
  process.env.OPENAI_BASE_URL = `http://localhost:${port}/v1`;

  const r = await routeMessageRequest(body("claude-sonnet-4-5", { stream: true }), new Headers());
  assert.match(r.response.headers.get("content-type") ?? "", /text\/event-stream/);
  const text = await r.response.text();
  assert.match(text, /event: message_start/);
  assert.match(text, /event: message_stop/);
});

/* ------------------------------- passthrough ------------------------------ */

test("passthrough forwards the body untranslated and injects auth", async () => {
  const port = await listen(
    createServer(async (req, res) => {
      lastPassthroughHeaders = req.headers;
      lastUpstream = JSON.parse((await readBuf(req)).toString("utf8")) as Record<string, unknown>;
      json(res, 200, { ok: true });
    }),
  );
  process.env.ANTHROPIC_API_KEY = "ant-real-key";
  process.env.ANTHROPIC_REAL_BASE_URL = `http://localhost:${port}`;

  const r = await routeMessageRequest(
    body("claude-sonnet-4-5"),
    new Headers({ "content-type": "application/json", host: "should-be-dropped", "x-custom": "kept" }),
  );
  assert.equal(r.route, "anthropic");
  assert.equal(r.response.status, 200);

  // Body untouched — no OpenAI translation on this leg.
  assert.equal(lastUpstream!.model, "claude-sonnet-4-5");
  assert.ok(!("messages" in lastUpstream! && lastUpstream!.tools));

  // Auth injected, hop-by-hop headers dropped, caller headers preserved.
  assert.equal(lastPassthroughHeaders["x-api-key"], "ant-real-key");
  assert.equal(lastPassthroughHeaders["anthropic-version"], "2023-06-01");
  assert.equal(lastPassthroughHeaders["x-custom"], "kept");
  assert.notEqual(lastPassthroughHeaders.host, "should-be-dropped");
});

test("passthrough relays the upstream status code", async () => {
  const port = await listen(
    createServer(async (req, res) => {
      await readBuf(req);
      json(res, 401, { error: { message: "bad key" } });
    }),
  );
  process.env.ANTHROPIC_REAL_BASE_URL = `http://localhost:${port}`;
  const r = await routeMessageRequest(body("claude-sonnet-4-5"), new Headers());
  assert.equal(r.response.status, 401);
});

test("an empty body still routes to passthrough without throwing", async () => {
  const port = await listen(
    createServer(async (req, res) => {
      await readBuf(req);
      json(res, 200, { ok: true });
    }),
  );
  process.env.ANTHROPIC_REAL_BASE_URL = `http://localhost:${port}`;
  const r = await routeMessageRequest(undefined, new Headers());
  assert.equal(r.route, "anthropic");
  assert.equal(r.incomingModel, undefined);
});

test("routing flag off sends traffic to Anthropic even with OpenAI vars set", async () => {
  const port = await listen(
    createServer(async (req, res) => {
      await readBuf(req);
      json(res, 200, { ok: true });
    }),
  );
  process.env.USE_OPENAI_API = "0";
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.OPENAI_MODEL = "m";
  process.env.ANTHROPIC_REAL_BASE_URL = `http://localhost:${port}`;
  assert.equal((await routeMessageRequest(body("claude-sonnet-4-5"), new Headers())).route, "anthropic");
});
