// Regression: a gzipped upstream response reached the client as a ZlibError.
//
// fetch() transparently decompresses, but `upstream.headers` still says
// `content-encoding: gzip`. Forwarding that header alongside the already
// decompressed body makes the client try to inflate plain JSON:
//
//   API Error: ZlibError fetching "http://localhost:8787/v1/messages?beta=true"

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { forwardableHeaders, routeMessageRequest } from "../src/proxy.ts";

const servers: Server[] = [];
const saved = { ...process.env };

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const k of ["USE_OPENAI_API", "ANTHROPIC_API_KEY", "OSCAR_UPSTREAM_BASE_URL", "OSCAR_AUTH"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function listen(s: Server): Promise<number> {
  servers.push(s);
  return new Promise((r) =>
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      r(typeof a === "object" && a ? a.port : 0);
    }),
  );
}

/* ------------------------------ unit level -------------------------------- */

test("content-encoding is stripped — it no longer describes the body", () => {
  const h = new Headers({ "content-encoding": "gzip", "content-type": "application/json" });
  const out = forwardableHeaders(h);
  assert.equal(out.get("content-encoding"), null);
  assert.equal(out.get("content-type"), "application/json");
});

test("stale framing headers are stripped", () => {
  const h = new Headers({
    "content-length": "123",
    "transfer-encoding": "chunked",
    connection: "keep-alive",
  });
  const out = forwardableHeaders(h);
  for (const k of ["content-length", "transfer-encoding", "connection"]) {
    assert.equal(out.get(k), null, `${k} should not be forwarded`);
  }
});

test("every other header is preserved", () => {
  const h = new Headers({
    "anthropic-version": "2023-06-01",
    "request-id": "req_123",
    "x-ratelimit-remaining": "42",
  });
  const out = forwardableHeaders(h);
  assert.equal(out.get("anthropic-version"), "2023-06-01");
  assert.equal(out.get("request-id"), "req_123");
  assert.equal(out.get("x-ratelimit-remaining"), "42");
});

test("stripping is case-insensitive", () => {
  const out = forwardableHeaders(new Headers({ "Content-Encoding": "br" }));
  assert.equal(out.get("content-encoding"), null);
});

/* ------------------------------- end to end ------------------------------- */

test("a gzipped upstream response is readable by the caller", async () => {
  // The exact shape that produced the ZlibError.
  const payload = JSON.stringify({
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "hello from a gzipped upstream" }],
  });
  const gz = gzipSync(Buffer.from(payload));

  const upstream = createServer((req, res) => {
    req.resume();
    res.writeHead(200, {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "content-length": String(gz.length),
    });
    res.end(gz);
  });
  const port = await listen(upstream);

  process.env.USE_OPENAI_API = "0";
  process.env.OSCAR_AUTH = "api-key";
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.OSCAR_UPSTREAM_BASE_URL = `http://localhost:${port}`;

  const { response } = await routeMessageRequest(
    JSON.stringify({ model: "claude-opus-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    new Headers({ "content-type": "application/json" }),
  );

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-encoding"),
    null,
    "forwarding content-encoding is what caused the ZlibError",
  );

  // The decisive check: the body parses. Before the fix the caller received
  // decompressed bytes labelled gzip and failed to inflate them.
  const body = (await response.json()) as { content: { text: string }[] };
  assert.equal(body.content[0]!.text, "hello from a gzipped upstream");
});

test("an uncompressed upstream response still passes through intact", async () => {
  const upstream = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json", "request-id": "req_abc" });
    res.end(JSON.stringify({ ok: true }));
  });
  const port = await listen(upstream);

  process.env.USE_OPENAI_API = "0";
  process.env.OSCAR_AUTH = "api-key";
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.OSCAR_UPSTREAM_BASE_URL = `http://localhost:${port}`;

  const { response } = await routeMessageRequest(
    JSON.stringify({ model: "claude-opus-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
    new Headers({ "content-type": "application/json" }),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("request-id"), "req_abc", "useful headers must survive");
  assert.deepEqual(await response.json(), { ok: true });
});
