// Node HTTP server: listens on PROXY_PORT and dispatches /v1/messages through
// the proxy. Everything else is passed through to Anthropic untouched so the
// CLI's other endpoints (count_tokens, models, etc.) keep working.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadConfig } from "./env.ts";
import { routeMessageRequest } from "./proxy.ts";
import { probeModels } from "./setup.ts";
import { clearCatalogCache, getCatalog, modelsResponse } from "./catalog.ts";
import { estimateInputTokens } from "./tokens.ts";
import { envFilePath, rewriteKey } from "./modelpicker.ts";
import type { AnthropicMessagesRequest } from "./types.ts";

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

  /* ----- control endpoints for live model switching (claude-code-free --switch) -----
   * These let the user switch the active backend model from another terminal
   * while the claude CLI is running, without restarting the proxy. They are
   * localhost-only (the server binds to localhost) and read/write the .env the
   * proxy already loads per request via loadConfig(). */
  if (path.startsWith("/_ccf/")) {
    const c = loadConfig();
    if (!c.useOpenAI) {
      sendJSON(res, 400, { error: "control endpoints require USE_OPENAI_API=1" });
      return;
    }

    // GET /_ccf/status — current model + backend.
    if (method === "GET" && path === "/_ccf/status") {
      sendJSON(res, 200, {
        openaiModel: c.openAIModel,
        openaiBaseURL: c.openAIBaseURL,
        openaiKey: c.openAIKey ? c.openAIKey.slice(0, 4) + "..." : null,
      });
      return;
    }

    // GET /_ccf/models — probe the live backend /models, sorted.
    if (method === "GET" && path === "/_ccf/models") {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (c.openAIKey) headers.authorization = `Bearer ${c.openAIKey}`;
      const models = await probeModels(c.openAIBaseURL, (url, init) =>
        fetch(url, { ...init, headers: { ...headers, ...((init?.headers as Record<string, string>) ?? {}) } } as RequestInit),
      );
      models.sort((a, b) => a.localeCompare(b));
      sendJSON(res, 200, { backend: c.openAIBaseURL, current: c.openAIModel, models });
      return;
    }

    // POST /_ccf/model { "model": "..." } — hot-swap OPENAI_MODEL for the
    // running proxy (mutates process.env so loadConfig() picks it up on the
    // next request) and persist to .env so the change survives a restart.
    if (method === "POST" && path === "/_ccf/model") {
      const body = await readBody(req);
      let parsed: { model?: string };
      try {
        parsed = JSON.parse(body.toString("utf8")) as { model?: string };
      } catch {
        sendJSON(res, 400, { error: "invalid JSON body" });
        return;
      }
      const model = (parsed.model ?? "").trim();
      if (!model) {
        sendJSON(res, 400, { error: "missing 'model' field" });
        return;
      }
      process.env.OPENAI_MODEL = model;
      // A switch usually follows a `ollama pull`, so drop the memo and let the
      // next request re-probe rather than serving a 60s-stale model list.
      clearCatalogCache();
      try {
        rewriteKey(envFilePath(), "OPENAI_MODEL", model);
      } catch (err) {
        // In-memory switch still succeeded; persistence is best-effort.
        console.error(`[warn] could not persist OPENAI_MODEL to .env: ${err instanceof Error ? err.message : err}`);
      }
      console.log(`[_ccf] switched OPENAI_MODEL → ${model}`);
      sendJSON(res, 200, { ok: true, openaiModel: model });
      return;
    }

    sendJSON(res, 404, { error: `unknown control endpoint: ${method} ${path}` });
    return;
  }

  // The main messages endpoint.
  if (method === "POST" && path === "/v1/messages") {
    const body = await readBody(req);
    try {
      const { response, route, incomingModel, upstreamModel } = await routeMessageRequest(
        body.length ? new Uint8Array(body) : undefined,
        toWebHeaders(req.headers),
      );
      console.log(
        `[${new Date().toISOString()}] POST /v1/messages → ${route} (${response.status})` +
          (incomingModel ? `  model: ${incomingModel} → ${upstreamModel ?? incomingModel}` : ""),
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

  // Token counting. Claude Code uses this to decide when to compact, and in
  // OpenAI-routing mode it can't reach the real endpoint (dummy key → 401), so
  // answer it locally. Passthrough mode still forwards to Anthropic below.
  if (method === "POST" && path === "/v1/messages/count_tokens" && cfg.useOpenAI) {
    const body = await readBody(req);
    try {
      const parsed = JSON.parse(body.toString("utf8")) as AnthropicMessagesRequest;
      const input_tokens = estimateInputTokens(parsed);
      sendJSON(res, 200, { input_tokens });
      console.log(`[${new Date().toISOString()}] POST /v1/messages/count_tokens → ~${input_tokens}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJSON(res, 400, { error: { type: "invalid_request_error", message: msg } });
    }
    return;
  }

  /* ----- gateway model discovery: this is what populates /model -----
   * On startup Claude Code fetches `${ANTHROPIC_BASE_URL}/v1/models?limit=1000`
   * and caches the result as extra entries in the /model picker. It requires
   * CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 and a non-anthropic base URL
   * (the launcher sets both), and it drops every id that doesn't match
   * /^(claude|anthropic)/i — hence the `claude-ccf-…` aliases from catalog.ts.
   * The real name rides along in `display_name`, which is what gets rendered. */
  if (method === "GET" && path === "/v1/models" && cfg.useOpenAI) {
    const c = loadConfig();
    try {
      const catalog = await getCatalog(c);
      sendJSON(res, 200, modelsResponse(catalog));
      console.log(
        `[${new Date().toISOString()}] GET /v1/models → advertised ${catalog.entries.length} backend model(s)`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[error] /v1/models: ${msg}`);
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