// End-to-end integration test: spins up a mock OpenAI server and the real
// proxy, then drives it with an Anthropic-format /v1/messages request and
// checks the translated response. No external network — both servers run
// in-process on ephemeral ports (node:http). Run with: npx tsx --test test/integration.test.ts

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { loadConfig } from "../src/env.ts";

// Re-implement the server startup in-process so we can point it at our mock.
import { routeMessageRequest } from "../src/proxy.ts";
import { clearCatalogCache, getCatalog, modelsResponse } from "../src/catalog.ts";
import type {
  MessagesRequest,
  MessagesResponse,
  OpenAIChatCompletionResponse,
  OpenAIStreamChunk,
} from "../src/types.ts";

let mockPort = 0;
let proxyPort = 0;
let mockServer: Server | null = null;
let proxyServer: Server | null = null;

// Mock OpenAI backend: records the last request it received.
let lastOpenAIRequest: unknown = null;

function readBuf(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** web Headers → plain object for res.writeHead. */
function headersToObj(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

/** Pipe a web `Response` (headers + body) into a Node ServerResponse. */
async function pipeWebToNode(webRes: Response, res: ServerResponse): Promise<void> {
  res.writeHead(webRes.status, headersToObj(webRes.headers));
  const rb = webRes.body;
  if (rb == null) {
    res.end();
    return;
  }
  const reader = rb.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

/** Backend model ids the mock advertises from /models. */
const MOCK_BACKEND_MODELS = ["glm-5.2:cloud", "qwen2.5:7b"];

function startMockOpenAI(recordedModel: string): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // Model listing — every OpenAI-compatible backend serves this, and the
    // proxy probes it to build the /model alias table.
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      const payload = Buffer.from(
        JSON.stringify({ object: "list", data: MOCK_BACKEND_MODELS.map((id) => ({ id })) }),
      );
      res.writeHead(200, { "content-type": "application/json", "content-length": payload.length });
      res.end(payload);
      return;
    }

    const raw = (await readBuf(req)).toString("utf8");
    if (!raw) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    lastOpenAIRequest = JSON.parse(raw);
    // /chat/completions non-streaming
    if (
      url.pathname.endsWith("/chat/completions") &&
      (lastOpenAIRequest as { stream?: boolean }).stream !== true
    ) {
      const body: OpenAIChatCompletionResponse = {
        id: "chatcmpl-mock",
        model: recordedModel,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hello from the mock backend.",
              tool_calls: [
                {
                  id: "call_mock",
                  type: "function",
                  function: { name: "run_bash", arguments: JSON.stringify({ command: "echo hi" }) },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      };
      const payload = Buffer.from(JSON.stringify(body));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": payload.length,
      });
      res.end(payload);
      return;
    }

    // streaming variant
    if (
      url.pathname.endsWith("/chat/completions") &&
      (lastOpenAIRequest as { stream?: boolean }).stream === true
    ) {
      const chunks: OpenAIStreamChunk[] = [
        { id: "x", choices: [{ index: 0, delta: { content: "He" }, finish_reason: null }] },
        { id: "x", choices: [{ index: 0, delta: { content: "llo" }, finish_reason: null }] },
        { id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      const enc = new TextEncoder();
      for (const c of chunks) {
        res.write(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
      }
      res.write(enc.encode("data: [DONE]\n\n"));
      res.end();
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
}

// A minimal in-process proxy that uses routeMessageRequest.
function startProxy(): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/healthz")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // Mirrors src/server.ts: the endpoint the CLI's gateway discovery hits.
    if (req.method === "GET" && url.pathname === "/v1/models") {
      const catalog = await getCatalog(loadConfig());
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(modelsResponse(catalog)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/messages") {
      const buf = await readBuf(req);
      const { response } = await routeMessageRequest(
        buf.length ? new Uint8Array(buf) : undefined,
        new Headers(req.headers as Record<string, string | string[]>),
      );
      await pipeWebToNode(response, res);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
}

// Each test starts its own mock + proxy on a fresh port. Track every one of
// them so teardown can close them all — otherwise the listeners keep the event
// loop alive and the test file hangs until the runner's timeout.
const openServers: Server[] = [];

function listenOnEphemeral(server: Server): Promise<number> {
  openServers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

after(async () => {
  await Promise.all(
    openServers.map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
  openServers.length = 0;
  clearCatalogCache();
  // restore env so other test files aren't affected
  process.env.USE_OPENAI_API = "";
  process.env.OPENAI_API_KEY = "";
  process.env.OPENAI_MODEL = "";
  process.env.OPENAI_BASE_URL = "";
});

test("e2e: /v1/messages is translated to /chat/completions and back", async () => {
  mockServer = startMockOpenAI("mock-model");
  mockPort = await listenOnEphemeral(mockServer);

  // Configure the proxy to use OpenAI routing against the mock.
  process.env.USE_OPENAI_API = "1";
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.OPENAI_MODEL = "deepseek-chat";
  process.env.OPENAI_BASE_URL = `http://localhost:${mockPort}/v1`;
  // loadConfig caches nothing (reads per call), so this takes effect immediately.

  proxyServer = startProxy();
  proxyPort = await listenOnEphemeral(proxyServer);

  const anthropicReq: MessagesRequest = {
    model: "claude-3-5-sonnet",
    max_tokens: 512,
    system: "be brief",
    messages: [
      { role: "user", content: "say hi" },
    ],
    tools: [
      {
        name: "run_bash",
        description: "run a command",
        input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    ],
    tool_choice: { type: "auto" },
    stream: false,
  };

  const res = await fetch(`http://localhost:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(anthropicReq),
  });
  assert.strictEqual(res.status, 200);
  const body = (await res.json()) as MessagesResponse;

  // The Anthropic-shaped response should carry the mock's text + tool_use.
  assert.strictEqual(body.type, "message");
  assert.strictEqual(body.role, "assistant");
  assert.strictEqual(body.stop_reason, "tool_use");
  const text = body.content.find((b) => b.type === "text");
  assert.strictEqual(text && text.type === "text" ? text.text : "", "Hello from the mock backend.");
  const toolUse = body.content.find((b) => b.type === "tool_use");
  assert.ok(toolUse, "expected a tool_use block");
  if (toolUse && toolUse.type === "tool_use") {
    assert.strictEqual(toolUse.name, "run_bash");
    assert.deepEqual(toolUse.input, { command: "echo hi" });
  }

  // The request the mock received should be OpenAI-shaped.
  const sent = lastOpenAIRequest as {
    model: string;
    messages: { role: string; content: string | null }[];
    tools?: { type: string; function: { name: string } }[];
    tool_choice?: string;
    stream: boolean;
  };
  assert.strictEqual(sent.model, "deepseek-chat");
  assert.strictEqual(sent.stream, false);
  assert.deepEqual(sent.messages[0], { role: "system", content: "be brief" });
  assert.deepEqual(sent.messages[1], { role: "user", content: "say hi" });
  assert.strictEqual(sent.tools?.[0]?.function.name, "run_bash");
  assert.strictEqual(sent.tool_choice, "auto");
});

test("e2e: streaming response is translated to Anthropic SSE events", async () => {
  mockServer = startMockOpenAI("mock-model");
  mockPort = await listenOnEphemeral(mockServer);
  process.env.USE_OPENAI_API = "1";
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.OPENAI_MODEL = "deepseek-chat";
  process.env.OPENAI_BASE_URL = `http://localhost:${mockPort}/v1`;

  proxyServer = startProxy();
  proxyPort = await listenOnEphemeral(proxyServer);

  const anthropicReq: MessagesRequest = {
    model: "claude-3-5-sonnet",
    max_tokens: 16,
    messages: [{ role: "user", content: "stream me hello" }],
    stream: true,
  };

  const res = await fetch(`http://localhost:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(anthropicReq),
  });
  assert.strictEqual(res.status, 200);
  assert.ok((res.headers.get("content-type") ?? "").includes("text/event-stream"));

  const text = await res.text();
  const eventTypes = text
    .split("\n")
    .filter((l) => l.startsWith("event:"))
    .map((l) => l.slice(7).trim());

  assert.strictEqual(eventTypes[0], "message_start");
  assert.ok(eventTypes.includes("content_block_start"));
  assert.strictEqual(eventTypes.filter((t) => t === "content_block_delta").length, 2);
  assert.ok(eventTypes.includes("content_block_stop"));
  assert.ok(eventTypes.includes("message_delta"));
  assert.strictEqual(eventTypes[eventTypes.length - 1], "message_stop");

  // The streamed text should reassemble to "Hello".
  const deltas = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter((d) => d && d !== "[DONE]")
    .map((d) => JSON.parse(d))
    .filter((e: { type?: string }) => e.type === "content_block_delta")
    .map((e: { delta?: { text?: string } }) => e.delta?.text ?? "")
    .join("");
  assert.strictEqual(deltas, "Hello");
});

test("e2e: /model discovery advertises backend models and routes to them", async () => {
  clearCatalogCache();
  mockServer = startMockOpenAI("mock-model");
  mockPort = await listenOnEphemeral(mockServer);
  process.env.USE_OPENAI_API = "1";
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.OPENAI_MODEL = "deepseek-chat";
  process.env.OPENAI_BASE_URL = `http://localhost:${mockPort}/v1`;

  proxyServer = startProxy();
  proxyPort = await listenOnEphemeral(proxyServer);

  // 1. What the CLI fetches at startup to populate the /model picker.
  const listRes = await fetch(`http://localhost:${proxyPort}/v1/models?limit=1000`);
  assert.strictEqual(listRes.status, 200);
  const list = (await listRes.json()) as {
    data: { id: string; display_name: string }[];
  };
  assert.strictEqual(list.data.length, MOCK_BACKEND_MODELS.length);
  for (const entry of list.data) {
    // Anything not matching this is silently dropped by the picker.
    assert.match(entry.id, /^(claude|anthropic)/i);
  }
  assert.deepEqual(
    list.data.map((d) => d.display_name).sort(),
    [...MOCK_BACKEND_MODELS].sort(),
  );

  // 2. Picking "glm-5.2:cloud" sends its alias back as body.model.
  const picked = list.data.find((d) => d.display_name === "glm-5.2:cloud");
  assert.ok(picked, "expected glm-5.2:cloud in the advertised list");

  const res = await fetch(`http://localhost:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: picked.id,
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    } satisfies MessagesRequest),
  });
  assert.strictEqual(res.status, 200);

  // 3. The backend must be called with the real name, not the alias — and not
  //    with OPENAI_MODEL, which the picked model overrides.
  assert.strictEqual((lastOpenAIRequest as { model: string }).model, "glm-5.2:cloud");
});

test("e2e: passthrough mode is used when USE_OPENAI_API is unset", async () => {
  // In passthrough mode the proxy forwards to ANTHROPIC_BASE_URL. Point that
  // at our mock (re-used as a stand-in for Anthropic) and assert the body is
  // forwarded verbatim, not translated.
  process.env.USE_OPENAI_API = "";
  let receivedPath = "";
  let receivedBody: unknown = null;
  const fakeAnthropic = createServer(async (req, res) => {
    receivedPath = new URL(req.url ?? "/", "http://localhost").pathname;
    receivedBody = JSON.parse((await readBuf(req)).toString("utf8"));
    const payload = JSON.stringify({
      id: "msg_passthrough",
      type: "message",
      role: "assistant",
      model: "claude",
      content: [{ type: "text", text: "passthrough ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    } satisfies MessagesResponse);
    const buf = Buffer.from(payload);
    res.writeHead(200, { "content-type": "application/json", "content-length": buf.length });
    res.end(buf);
  });
  const fakePort = await listenOnEphemeral(fakeAnthropic);

  process.env.ANTHROPIC_API_KEY = "ant-test";
  // env.ts prefers OSCAR_UPSTREAM_BASE_URL, then ANTHROPIC_BASE_URL.
  process.env.OSCAR_UPSTREAM_BASE_URL = `http://localhost:${fakePort}`;

  proxyServer = startProxy();
  proxyPort = await listenOnEphemeral(proxyServer);

  const anthropicReq: MessagesRequest = {
    model: "claude-3-5-sonnet",
    max_tokens: 8,
    messages: [{ role: "user", content: "passthrough please" }],
  };

  const res = await fetch(`http://localhost:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(anthropicReq),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(receivedPath, "/v1/messages");
  // Body forwarded verbatim (model unchanged — not translated to OpenAI).
  assert.strictEqual((receivedBody as MessagesRequest).model, "claude-3-5-sonnet");
  assert.deepEqual((receivedBody as MessagesRequest).messages[0], {
    role: "user",
    content: "passthrough please",
  });

  const body = (await res.json()) as MessagesResponse;
  assert.deepEqual(body.content[0], { type: "text", text: "passthrough ok" });

  await new Promise<void>((r) => fakeAnthropic.close(() => r()));
});

// Touch loadConfig so the import isn't elided under strict settings.
test("env sanity: loadConfig returns the proxy port", () => {
  process.env.PROXY_PORT = "9999";
  const cfg = loadConfig();
  assert.strictEqual(cfg.port, 9999);
  delete process.env.PROXY_PORT;
});