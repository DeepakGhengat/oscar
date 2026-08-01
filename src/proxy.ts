// Request routing: /v1/messages → OpenAI chat-completions (translated) OR
// transparent passthrough to the real Anthropic API when USE_OPENAI_API is off.

import { buildOpenAIRequest, translateOpenAIResponse } from "./openaiShim.ts";
import { StreamTranslator } from "./stream.ts";
import type {
  AnthropicMessagesRequest,
  OpenAIChatCompletionResponse,
  OpenAIStreamChunk,
  ProxyConfig,
} from "./types.ts";
import { loadConfig } from "./env.ts";
import { probeModels } from "./setup.ts";

const ANTHROPIC_VERSION = "2023-06-01";

/* --------- backend model set (for respecting body.model overrides) --------
 * claude's /model menu maps tier names → backend models via `modelOverrides`
 * in settings.json. When the user picks a tier, claude sends the mapped
 * backend model id in the request body's `model` field. We want to honor
 * that — but only when it's a real backend model (so the default flow, where
 * the body carries an Anthropic id, still falls back to OPENAI_MODEL).
 *
 * The set is probed lazily and cached for 60s so /_ccf/model hot-swaps and
 * freshly-deployed models are picked up without a restart. */
let backendModelsCache: Set<string> | null = null;
let backendModelsAt = 0;
const BACKEND_MODELS_TTL_MS = 60_000;

async function getBackendModels(cfg: ProxyConfig): Promise<Set<string>> {
  if (backendModelsCache && Date.now() - backendModelsAt < BACKEND_MODELS_TTL_MS) {
    return backendModelsCache;
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.openAIKey) headers.authorization = `Bearer ${cfg.openAIKey}`;
  const ids = await probeModels(cfg.openAIBaseURL, (url, init) =>
    fetch(url, {
      ...init,
      headers: { ...headers, ...((init?.headers as Record<string, string>) ?? {}) },
    } as RequestInit),
  );
  backendModelsCache = new Set(ids);
  backendModelsAt = Date.now();
  return backendModelsCache;
}

/** Resolve the upstream model: prefer body.model when it's a known backend
 * model (so /model overrides take effect), else fall back to OPENAI_MODEL. */
async function resolveUpstreamModel(
  cfg: ProxyConfig,
  bodyModel: string | undefined,
): Promise<string | null> {
  if (bodyModel) {
    const backend = await getBackendModels(cfg);
    if (backend.has(bodyModel)) return bodyModel;
  }
  return cfg.openAIModel ?? bodyModel ?? null;
}

function authHeaders(cfg: ProxyConfig, target: "openai" | "anthropic"): Record<string, string> {
  if (target === "openai") {
    return { Authorization: `Bearer ${cfg.openAIKey ?? ""}` };
  }
  return {
    "x-api-key": cfg.anthropicKey ?? "",
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

/* --------------------------- OpenAI routing ------------------------------- */

async function callOpenAI(
  cfg: ProxyConfig,
  body: AnthropicMessagesRequest,
): Promise<Response> {
  const upstreamModel = await resolveUpstreamModel(cfg, body.model);
  const openaiReq = buildOpenAIRequest(body, upstreamModel ?? body.model);
  const url = `${cfg.openAIBaseURL}/chat/completions`;

  const upstream = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(cfg, "openai") },
    body: JSON.stringify(openaiReq),
  });

  if (!upstream.ok) {
    // Surface the upstream error verbatim so the CLI shows something useful.
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  }

  if (openaiReq.stream) {
    return streamFromOpenAI(upstream, upstreamModel ?? body.model);
  }

  const json = (await upstream.json()) as OpenAIChatCompletionResponse;
  const translated = translateOpenAIResponse(json, body.model);
  return new Response(JSON.stringify(translated), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Convert an OpenAI SSE stream into an Anthropic SSE stream. */
function streamFromOpenAI(upstream: Response, model: string): Response {
  const decoder = new TextDecoder();
  const reader = upstream.body?.getReader();
  if (!reader) {
    return new Response("upstream had no body", { status: 502 });
  }

  const translator = new StreamTranslator(model);

  const sse = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let buffer = "";

      const emit = (ev: { type: string }) => {
        controller.enqueue(encoder.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by double newlines.
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            let line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            line = line.trim();
            if (!line || line.startsWith(":")) continue; // blank/comment
            if (line.startsWith("data:")) {
              const data = line.slice(5).trim();
              if (data === "[DONE]") {
                for (const ev of translator.flush()) emit(ev);
                controller.close();
                return;
              }
              try {
                const chunk = JSON.parse(data) as OpenAIStreamChunk;
                for (const ev of translator.feed(chunk)) emit(ev);
              } catch {
                // ignore malformed keep-alive lines
              }
            }
          }
        }
      } catch (err) {
        controller.error(err);
        return;
      }
      for (const ev of translator.flush()) emit(ev);
      controller.close();
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  return new Response(sse, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/* --------------------------- Anthropic passthrough ------------------------ */

async function passthroughAnthropic(
  cfg: ProxyConfig,
  path: string,
  method: string,
  headers: Headers,
  body: Uint8Array | string | undefined,
): Promise<Response> {
  const url = `${cfg.anthropicBaseURL}${path}`;
  const outHeaders = new Headers();
  for (const [k, v] of headers.entries()) {
    const lk = k.toLowerCase();
    if (lk === "host" || lk === "content-length") continue;
    outHeaders.set(k, v);
  }
  // Ensure auth headers are correct even if the CLI omitted them.
  for (const [k, v] of Object.entries(authHeaders(cfg, "anthropic"))) outHeaders.set(k, v);
  if (!outHeaders.has("content-type")) outHeaders.set("content-type", "application/json");

  const init: RequestInit = { method, headers: outHeaders };
  if (body !== undefined) init.body = body;

  const upstream = await fetch(url, init);

  // Stream the upstream response straight back.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

/* ------------------------------- dispatch --------------------------------- */

export interface RouteResult {
  response: Response;
  route: "openai" | "anthropic" | "passthrough";
  incomingModel?: string;
  upstreamModel?: string;
}

export async function routeMessageRequest(
  body: Uint8Array | string | undefined,
  headers: Headers,
): Promise<RouteResult> {
  const cfg = loadConfig();
  const parsed = body ? (JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body)) as AnthropicMessagesRequest) : undefined;

  if (cfg.useOpenAI && parsed) {
    const upstreamModel = await resolveUpstreamModel(cfg, parsed.model);
    const response = await callOpenAI(cfg, parsed);
    return {
      response,
      route: "openai",
      incomingModel: parsed.model,
      upstreamModel: upstreamModel ?? parsed.model,
    };
  }
  // Passthrough: keep native Anthropic behaviour intact.
  const response = await passthroughAnthropic(cfg, "/v1/messages", "POST", headers, body);
  return {
    response,
    route: "anthropic",
    incomingModel: parsed?.model,
    upstreamModel: parsed?.model,
  };
}