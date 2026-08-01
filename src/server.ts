// Node HTTP server: listens on PROXY_PORT and dispatches /v1/messages through
// the proxy. Everything else is passed through to Anthropic untouched so the
// CLI's other endpoints (count_tokens, models, etc.) keep working.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadConfig } from "./env.ts";
import { routeMessageRequest } from "./proxy.ts";

const cfg = loadConfig();

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Node's IncomingHttpHeaders → web Headers (fetch/proxy expect the latter). */
function toWebHeaders(h: IncomingMessage["headers"]): Headers {
  return new Headers(h as Record<string, string | string[]>);
}

/** web Headers → a plain object suitable for res.writeHead. */
function headersToObj(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

/** Stream a web Response's body (headers + body) into a Node ServerResponse. */
function writeWebResponse(res: ServerResponse, status: number, headers: Headers): void {
  res.writeHead(status, headersToObj(headers));
}

async function pumpWebBody(res: ServerResponse, rb: ReadableStream<Uint8Array> | Uint8Array | null): Promise<void> {
  if (rb == null) {
    res.end();
    return;
  }
  if (rb instanceof Uint8Array) {
    res.end(rb);
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

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${cfg.port}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  // Health probe — handy for scripts.
  if (method === "GET" && (path === "/" || path === "/healthz")) {
    const c = loadConfig();
    sendJSON(res, 200, {
      ok: true,
      route: c.useOpenAI ? "openai" : "anthropic",
      openaiModel: c.openAIModel,
      openaiBaseURL: c.openAIBaseURL,
      port: c.port,
    });
    return;
  }

  // The main messages endpoint.
  if (method === "POST" && path === "/v1/messages") {
    const body = await readBody(req);
    try {
      const { response, route } = await routeMessageRequest(
        body.length ? new Uint8Array(body) : undefined,
        toWebHeaders(req.headers),
      );
      console.log(
        `[${new Date().toISOString()}] POST /v1/messages → ${route} (${response.status})`,
      );
      writeWebResponse(res, response.status, response.headers);
      // Stream the (possibly ReadableStream) body back through Node.
      await pumpWebBody(res, response.body as ReadableStream<Uint8Array> | Uint8Array | null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[error] ${msg}`);
      sendJSON(res, 500, { error: { type: "proxy_error", message: msg } });
    }
    return;
  }

  // Fallback: pass any other path straight to Anthropic (count_tokens, models...).
  const body = await readBody(req);
  const init: RequestInit = { method, headers: toWebHeaders(req.headers) };
  if (body.length) init.body = new Uint8Array(body);
  try {
    const upstream = await fetch(`${cfg.anthropicBaseURL}${path}`, init);
    writeWebResponse(res, upstream.status, upstream.headers);
    await pumpWebBody(res, upstream.body as ReadableStream<Uint8Array> | Uint8Array | null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[error] passthrough: ${msg}`);
    sendJSON(res, 502, { error: { type: "proxy_error", message: msg } });
  }
});

server.listen(cfg.port, () => {
  console.log(`claude-code-free proxy listening on http://localhost:${cfg.port}`);
  console.log(
    `  routing: ${cfg.useOpenAI ? "OpenAI-compatible → " + cfg.openAIBaseURL : "passthrough → Anthropic"}`,
  );
  console.log(`  health:  http://localhost:${cfg.port}/healthz`);
});