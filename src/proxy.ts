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
import { getCatalog, toBackendModel } from "./catalog.ts";

const ANTHROPIC_VERSION = "2023-06-01";

/** Resolve the upstream model.
 *
 * When the user picks a backend model from `/model`, Claude Code sends the id
 * we advertised through gateway discovery (a `claude-ccf-…` alias) as
 * `body.model`. Map that back to the real backend name. Anything else — the
 * usual case, where the body carries an Anthropic tier id — falls back to the
 * configured OPENAI_MODEL. */
async function resolveUpstreamModel(
  cfg: ProxyConfig,
  bodyModel: string | undefined,
): Promise<string | null> {
  if (bodyModel) {
    const catalog = await getCatalog(cfg);
    const backend = toBackendModel(catalog, bodyModel);
    if (backend) return backend;
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
  upstreamModel: string,
): Promise<Response> {
  const openaiReq = buildOpenAIRequest(body, upstreamModel, cfg.maxOutputTokens);
  const url = `${cfg.openAIBaseURL}/chat/completions`;

  const upstream = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(cfg, "openai") },
    body: JSON.stringify(openaiReq),
  });

  if (!upstream.ok) {
    // Wrap the upstream error in Anthropic's envelope so the CLI renders our
    // message instead of a bare `API Error: 401 {"error":"Unauthorized"}` —
    // which reads as *Claude Code's* login failing rather than the backend
    // refusing OPENAI_API_KEY. The original body is preserved inside.
    const text = await upstream.text();
    const auth = upstream.status === 401 || upstream.status === 403;
    if (auth) {
      console.error(
        `[error] ${cfg.openAIBaseURL} rejected OPENAI_API_KEY (${upstream.status}). ` +
          `This is your backend key, not Claude Code's login. ` +
          `Re-run 'claude-code-free --setup' or fix the key in your .env.`,
      );
    }
    const message = auth
      ? `Your backend rejected the request (${upstream.status}). ${cfg.openAIBaseURL} refused OPENAI_API_KEY — ` +
        `this is not a Claude Code login problem. Run 'claude-code-free --doctor' to check the config. ` +
        `Upstream said: ${text.slice(0, 300)}`
      : `Backend ${cfg.openAIBaseURL} returned ${upstream.status}: ${text.slice(0, 300)}`;

    return new Response(
      JSON.stringify({
        type: "error",
        error: { type: auth ? "authentication_error" : "api_error", message },
      }),
      { status: upstream.status, headers: { "content-type": "application/json" } },
    );
  }

  if (openaiReq.stream) {
    return streamFromOpenAI(upstream, upstreamModel);
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
    const upstreamModel = (await resolveUpstreamModel(cfg, parsed.model)) ?? parsed.model;
    const response = await callOpenAI(cfg, parsed, upstreamModel);
    return { response, route: "openai", incomingModel: parsed.model, upstreamModel };
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