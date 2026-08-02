// Does this backend config actually work?
//
// Probing /models is not enough. On Ollama Cloud (and several hosted
// gateways) the model listing is public: it returns 200 with no key, and 200
// with a made-up key. So a wizard that validates by listing models happily
// accepts a placeholder like "ollama" and the mistake only surfaces later, as
// a 401 during a real conversation that reads like the CLI's own login
// failing. The only honest check is a real completion.

export interface PreflightResult {
  ok: boolean;
  /** Machine-readable failure class, for callers that want to react. */
  kind: "ok" | "auth" | "model" | "unreachable" | "http";
  status: number | null;
  /** One line, safe to print. */
  message: string;
}

/** Values people leave in place that are not real credentials. */
const PLACEHOLDER_KEYS = new Set(["ollama", "lm-studio", "lmstudio", "vllm", "none", "no-key", "x", "sk-", ""]);

/** True when the key looks like a preset default rather than a real secret. */
export function isPlaceholderKey(key: string | null | undefined): boolean {
  return PLACEHOLDER_KEYS.has((key ?? "").trim().toLowerCase());
}

/** True when the backend is remote, so a placeholder key will not do. */
export function isRemoteBackend(baseURL: string): boolean {
  try {
    // URL.hostname keeps the brackets on IPv6 literals: "[::1]".
    const host = new URL(baseURL).hostname.replace(/^\[|\]$/g, "");
    return !["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host);
  } catch {
    return false;
  }
}

/** Send the smallest possible real completion and report what happened. */
export async function verifyBackend(
  opts: { baseURL: string; apiKey: string | null; model: string },
  fetchImpl: typeof fetch = fetch,
): Promise<PreflightResult> {
  const url = `${opts.baseURL.replace(/\/$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: opts.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      kind: "unreachable",
      status: null,
      message: `could not reach ${opts.baseURL} (${detail})`,
    };
  }

  if (res.ok) {
    return { ok: true, kind: "ok", status: res.status, message: `${opts.model} responded` };
  }

  const body = (await res.text().catch(() => "")).slice(0, 200);

  if (res.status === 401 || res.status === 403) {
    const hint = isPlaceholderKey(opts.apiKey)
      ? ` — the configured key is the placeholder ${JSON.stringify(opts.apiKey ?? "")}, not a real credential`
      : "";
    return {
      ok: false,
      kind: "auth",
      status: res.status,
      message: `${opts.baseURL} rejected the API key (${res.status})${hint}`,
    };
  }

  if (res.status === 404) {
    return {
      ok: false,
      kind: "model",
      status: res.status,
      message: `${opts.baseURL} does not serve a model named ${JSON.stringify(opts.model)}`,
    };
  }

  return {
    ok: false,
    kind: "http",
    status: res.status,
    message: `${opts.baseURL} returned ${res.status}${body ? `: ${body}` : ""}`,
  };
}
