// Request routing: /v1/messages → OpenAI chat-completions (translated) OR
// transparent passthrough to the real Anthropic API when USE_OPENAI_API is off.

import { buildOpenAIRequest, translateOpenAIResponse } from "./openaiShim.ts";
import { StreamTranslator } from "./stream.ts";
import type {
  MessagesRequest,
  OpenAIChatCompletionResponse,
  OpenAIStreamChunk,
  ProxyConfig,
} from "./types.ts";
import { loadConfig } from "./env.ts";
import { getCatalog, toBackendModel } from "./catalog.ts";
import {
  DEFAULT_PROVIDER,
  loadProviders,
  resolveMaxOutputTokens,
  type Provider,
} from "./providers.ts";

const MESSAGES_API_VERSION = "2023-06-01";

/** Where a request is actually going: which backend, under which name. */
interface Target {
  provider: Provider;
  model: string;
  maxOutputTokens: number | null;
}

/** Resolve the upstream target.
 *
 * When the user picks a backend model from `/model`, the CLI sends the id
 * we advertised through gateway discovery (a `claude-oscar-…` alias) as
 * `body.model`. Map that back to the real provider + model. Anything else —
 * the usual case, where the body carries an Anthropic tier id — falls back to
 * the default provider and OPENAI_MODEL. */
async function resolveTarget(
  cfg: ProxyConfig,
  bodyModel: string | undefined,
): Promise<Target> {
  if (bodyModel) {
    const entry = toBackendModel(await getCatalog(cfg), bodyModel);
    if (entry) {
      return {
        provider: entry.provider,
        model: entry.id,
        maxOutputTokens: resolveMaxOutputTokens(entry.provider, entry.id, cfg.maxOutputTokens),
      };
    }
  }

  const { providers } = loadProviders(cfg);
  const provider =
    providers.find((p) => p.id === DEFAULT_PROVIDER) ??
    providers[0] ?? { id: DEFAULT_PROVIDER, baseURL: cfg.openAIBaseURL, apiKey: cfg.openAIKey };
  const model = cfg.openAIModel ?? bodyModel ?? "";
  return {
    provider,
    model,
    maxOutputTokens: resolveMaxOutputTokens(provider, model, cfg.maxOutputTokens),
  };
}

/** True when the caller already carries usable credentials of its own.
 *
 * A subscription login (Pro/Max/Team, or enterprise SSO) reaches us as
 * `Authorization: Bearer <oauth token>` and no `x-api-key` at all. Those
 * tokens are short-lived and refreshed by the CLI, so they are the only
 * credentials that can work — we have nothing equivalent to substitute. */
export function callerIsAuthenticated(headers: Headers): boolean {
  return (
    (headers.get("authorization") ?? "").trim() !== "" ||
    (headers.get("x-api-key") ?? "").trim() !== ""
  );
}

/** Does this model id name something one of our backends actually serves?
 *
 * True for an alias we advertised, and for a real backend id typed straight
 * into `/model`. False for the CLI's own tier ids — which is what tells hybrid
 * routing to send the request to the vendor instead. */
export async function isBackendModel(
  cfg: ProxyConfig,
  bodyModel: string | undefined,
): Promise<boolean> {
  if (!bodyModel) return false;
  return toBackendModel(await getCatalog(cfg), bodyModel) !== null;
}

/** Headers to force on a passthrough request.
 *
 * Only ever *adds* credentials, never replaces them. Injecting our own
 * `x-api-key` next to a caller's bearer token makes the API reject the whole
 * request — and an empty `x-api-key`, which is what a missing key used to
 * produce, breaks it just as thoroughly. */
export function upstreamAuthHeaders(
  cfg: ProxyConfig,
  incoming?: Headers,
): Record<string, string> {
  const headers: Record<string, string> = {
    "anthropic-version": MESSAGES_API_VERSION,
    "anthropic-dangerous-direct-browser-access": "true",
  };
  if (cfg.upstreamAuth === "subscription") return headers;
  if (incoming && callerIsAuthenticated(incoming)) return headers;
  if (cfg.upstreamKey) headers["x-api-key"] = cfg.upstreamKey;
  return headers;
}

/* --------------------------- OpenAI routing ------------------------------- */

async function callOpenAI(
  body: MessagesRequest,
  target: Target,
): Promise<Response> {
  const { provider } = target;
  const openaiReq = buildOpenAIRequest(body, target.model, target.maxOutputTokens);
  const url = `${provider.baseURL}/chat/completions`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

  const upstream = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(openaiReq),
  });

  if (!upstream.ok) {
    // Wrap the upstream error in Anthropic's envelope so the CLI renders our
    // message instead of a bare `API Error: 401 {"error":"Unauthorized"}` —
    // which reads as *the CLI's* login failing rather than the backend
    // refusing its key. The original body is preserved inside.
    const text = await upstream.text();
    const auth = upstream.status === 401 || upstream.status === 403;
    const who = `${provider.baseURL} (provider "${provider.id}")`;
    if (auth) {
      console.error(
        `[error] ${who} rejected the API key (${upstream.status}). ` +
          `This is your backend key, not the CLI's login. ` +
          `Run 'oscar --doctor' to check the config.`,
      );
    }
    const message = auth
      ? `Your backend rejected the request (${upstream.status}). ${who} refused the API key — ` +
        `this is not a the CLI login problem. Run 'oscar --doctor' to check the config. ` +
        `Upstream said: ${text.slice(0, 300)}`
      : `Backend ${who} returned ${upstream.status}: ${text.slice(0, 300)}`;

    return new Response(
      JSON.stringify({
        type: "error",
        error: { type: auth ? "authentication_error" : "api_error", message },
      }),
      { status: upstream.status, headers: { "content-type": "application/json" } },
    );
  }

  if (openaiReq.stream) {
    return streamFromOpenAI(upstream, target.model);
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

async function passthroughUpstream(
  cfg: ProxyConfig,
  path: string,
  method: string,
  headers: Headers,
  body: Uint8Array | string | undefined,
): Promise<Response> {
  const url = `${cfg.upstreamBaseURL}${path}`;
  const outHeaders = new Headers();
  for (const [k, v] of headers.entries()) {
    const lk = k.toLowerCase();
    if (lk === "host" || lk === "content-length") continue;
    outHeaders.set(k, v);
  }
  // Fill in auth only where the caller left a gap; never overwrite what it sent.
  for (const [k, v] of Object.entries(upstreamAuthHeaders(cfg, headers))) outHeaders.set(k, v);
  // An empty x-api-key is worse than none — the API rejects it outright, which
  // is how a signed-in CLI used to fail here.
  if ((outHeaders.get("x-api-key") ?? "").trim() === "") outHeaders.delete("x-api-key");
  if (!outHeaders.has("content-type")) outHeaders.set("content-type", "application/json");

  const init: RequestInit = { method, headers: outHeaders };
  if (body !== undefined) init.body = body;

  const upstream = await fetch(url, init);

  // Stream the upstream response straight back, minus the headers that no
  // longer describe what we are sending.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: forwardableHeaders(upstream.headers),
  });
}

/** Headers that describe the *upstream* transfer, not ours.
 *
 * fetch() transparently decompresses the body, so `content-encoding: gzip`
 * arrives attached to bytes that are no longer gzipped. Forwarding it makes
 * the client try to inflate plain JSON and fail with a ZlibError. The lengths
 * and framing headers are equally stale once the body has been re-emitted. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
]);

export function forwardableHeaders(h: Headers): Headers {
  const out = new Headers();
  h.forEach((v, k) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(k.toLowerCase())) out.append(k, v);
  });
  return out;
}

/* ------------------------------- dispatch --------------------------------- */

export interface RouteResult {
  response: Response;
  route: "openai" | "upstream" | "passthrough";
  incomingModel?: string;
  upstreamModel?: string;
  /** Which configured backend served it — for the request log. */
  provider?: string;
}

export async function routeMessageRequest(
  body: Uint8Array | string | undefined,
  headers: Headers,
): Promise<RouteResult> {
  const cfg = loadConfig();
  const parsed = body ? (JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body)) as MessagesRequest) : undefined;

  if (cfg.useOpenAI && parsed) {
    // Hybrid: one `/model` list spanning both worlds. Our aliases are the only
    // ids that mean "a backend model" — anything else the CLI sends is one of
    // its own tiers, and in hybrid that is a deliberate choice by the user, so
    // it goes to the vendor on the CLI's own credentials rather than being
    // quietly answered by whichever backend happens to be the default.
    if (cfg.hybrid && !(await isBackendModel(cfg, parsed.model))) {
      const response = await passthroughUpstream(cfg, "/v1/messages", "POST", headers, body);
      return {
        response,
        route: "upstream",
        incomingModel: parsed.model,
        upstreamModel: parsed.model,
      };
    }
    const target = await resolveTarget(cfg, parsed.model);
    const response = await callOpenAI(parsed, target);
    return {
      response,
      route: "openai",
      incomingModel: parsed.model,
      upstreamModel: target.model,
      provider: target.provider.id,
    };
  }
  // Passthrough: keep native Anthropic behaviour intact.
  const response = await passthroughUpstream(cfg, "/v1/messages", "POST", headers, body);
  return {
    response,
    route: "upstream",
    incomingModel: parsed?.model,
    upstreamModel: parsed?.model,
  };
}