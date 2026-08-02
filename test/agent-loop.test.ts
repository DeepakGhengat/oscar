// The agent loop and its streaming client, driven against a stubbed backend
// so the tool round-trip, permission gating and loop guard are all exercised
// without a model or a network.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { complete, safeArgs, type Message } from "../src/agent/client.ts";
import { Agent, systemPrompt } from "../src/agent/loop.ts";
import type { Provider } from "../src/providers.ts";

const realFetch = globalThis.fetch;
let cwd: string;
/** Bodies the stub received, so we can assert what was sent upstream. */
let sent: Record<string, unknown>[] = [];

const provider: Provider = { id: "test", baseURL: "http://backend/v1", apiKey: "k" };

/** Build an SSE body from chunk objects. */
function sse(chunks: unknown[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

const textChunk = (s: string) => ({ choices: [{ delta: { content: s }, finish_reason: null }] });
const stop = () => ({ choices: [{ delta: {}, finish_reason: "stop" }] });
const toolChunk = (name: string, args: string, index = 0) => ({
  choices: [
    {
      delta: { tool_calls: [{ index, id: `call_${index}`, function: { name, arguments: args } }] },
      finish_reason: null,
    },
  ],
});
const toolStop = () => ({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });

/** Serve a scripted sequence of responses, one per request. */
function stubBackend(responses: string[]): void {
  let i = 0;
  globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    sent.push(JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
    const body = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}

beforeEach(() => {
  sent = [];
  cwd = mkdtempSync(join(tmpdir(), "oscar-loop-"));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  try {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* cosmetic */
  }
});

/* --------------------------------- client --------------------------------- */

test("streamed text is assembled and emitted as it arrives", async () => {
  stubBackend([sse([textChunk("Hel"), textChunk("lo"), stop()])]);
  const seen: string[] = [];
  const turn = await complete({
    provider,
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    events: { onText: (d) => seen.push(d) },
  });
  assert.equal(turn.text, "Hello");
  assert.deepEqual(seen, ["Hel", "lo"]);
  assert.equal(turn.finish, "stop");
});

test("tool-call fragments are reassembled across chunks", async () => {
  stubBackend([sse([toolChunk("read_file", '{"path":'), toolChunk("", '"a.txt"}'), toolStop()])]);
  const turn = await complete({ provider, model: "m", messages: [{ role: "user", content: "x" }] });
  assert.equal(turn.toolCalls.length, 1);
  assert.equal(turn.toolCalls[0]!.name, "read_file");
  assert.deepEqual(safeArgs(turn.toolCalls[0]!.arguments), { path: "a.txt" });
  assert.equal(turn.finish, "tool_calls");
});

test("a backend reporting stop while emitting tool calls is corrected", async () => {
  // Several OpenAI-compatible servers do this; taking it literally would end
  // the turn with the tool calls unexecuted.
  stubBackend([sse([toolChunk("read_file", "{}"), stop()])]);
  const turn = await complete({ provider, model: "m", messages: [{ role: "user", content: "x" }] });
  assert.equal(turn.finish, "tool_calls");
});

test("reasoning is surfaced only while no real content has arrived", async () => {
  stubBackend([
    sse([
      { choices: [{ delta: { reasoning: "thinking" }, finish_reason: null }] },
      textChunk("answer"),
      { choices: [{ delta: { reasoning: "more" }, finish_reason: null }] },
      stop(),
    ]),
  ]);
  const reasoning: string[] = [];
  const turn = await complete({
    provider,
    model: "m",
    messages: [{ role: "user", content: "x" }],
    events: { onReasoning: (d) => reasoning.push(d) },
  });
  assert.deepEqual(reasoning, ["thinking"], "chain-of-thought must not follow real output");
  assert.equal(turn.text, "answer");
});

test("an auth failure names the provider", async () => {
  globalThis.fetch = (async () =>
    new Response('{"error":"Unauthorized"}', { status: 401 })) as typeof fetch;
  await assert.rejects(
    () => complete({ provider, model: "m", messages: [{ role: "user", content: "x" }] }),
    /provider "test".*401/s,
  );
});

test("tools are sent in OpenAI function format", async () => {
  stubBackend([sse([textChunk("ok"), stop()])]);
  await complete({
    provider,
    model: "m",
    messages: [{ role: "user", content: "x" }],
    tools: [{ name: "t", description: "d", parameters: { type: "object" } }],
  });
  const body = sent[0] as { tools: { type: string; function: { name: string } }[]; tool_choice: string };
  assert.equal(body.tools[0]!.type, "function");
  assert.equal(body.tools[0]!.function.name, "t");
  assert.equal(body.tool_choice, "auto");
});

test("malformed tool arguments parse to an empty object, not a crash", () => {
  assert.deepEqual(safeArgs("{broken"), {});
  assert.deepEqual(safeArgs(""), {});
  assert.deepEqual(safeArgs('{"a":1}'), { a: 1 });
});

/* ---------------------------------- loop ---------------------------------- */

test("a tool call runs and its result is fed back for a second turn", async () => {
  writeFileSync(join(cwd, "a.txt"), "file contents");
  stubBackend([
    sse([toolChunk("read_file", JSON.stringify({ path: "a.txt" })), toolStop()]),
    sse([textChunk("It says: file contents"), stop()]),
  ]);

  const agent = new Agent({ provider, model: "m", cwd });
  let out = "";
  await agent.send("what is in a.txt?", { onText: (d) => (out += d) });

  assert.match(out, /file contents/);
  assert.equal(sent.length, 2, "the tool result must trigger a follow-up turn");
  const second = sent[1] as { messages: Message[] };
  const toolMsg = second.messages.find((m) => m.role === "tool");
  assert.ok(toolMsg, "the second request must carry the tool result");
  assert.match(String((toolMsg as { content: string }).content), /file contents/);
});

test("a write is gated on approval", async () => {
  stubBackend([
    sse([toolChunk("write_file", JSON.stringify({ path: "new.txt", content: "x" })), toolStop()]),
    sse([textChunk("done"), stop()]),
  ]);
  const asked: string[] = [];
  const agent = new Agent({ provider, model: "m", cwd });
  await agent.send("write it", {
    onApprove: async (_t, summary) => {
      asked.push(summary);
      return "allow";
    },
  });
  assert.equal(asked.length, 1, "a write must prompt");
  assert.equal(readFileSync(join(cwd, "new.txt"), "utf8"), "x");
});

test("denial blocks the write and tells the model not to retry", async () => {
  stubBackend([
    sse([toolChunk("write_file", JSON.stringify({ path: "blocked.txt", content: "x" })), toolStop()]),
    sse([textChunk("understood"), stop()]),
  ]);
  const agent = new Agent({ provider, model: "m", cwd });
  await agent.send("write it", { onApprove: async () => "deny" });

  assert.equal(existsSyncSafe(join(cwd, "blocked.txt")), false, "the file must not exist");
  const second = sent[1] as { messages: { role: string; content?: string }[] };
  const toolMsg = second.messages.find((m) => m.role === "tool");
  assert.match(String(toolMsg?.content), /declined/i);
});

test("reads are never gated", async () => {
  writeFileSync(join(cwd, "a.txt"), "x");
  stubBackend([
    sse([toolChunk("read_file", JSON.stringify({ path: "a.txt" })), toolStop()]),
    sse([textChunk("ok"), stop()]),
  ]);
  let prompted = false;
  const agent = new Agent({ provider, model: "m", cwd });
  await agent.send("read it", {
    onApprove: async () => {
      prompted = true;
      return "allow";
    },
  });
  assert.equal(prompted, false, "a read must not interrupt the user");
});

test("'always' grants the whole risk class for the session", async () => {
  stubBackend([
    sse([toolChunk("write_file", JSON.stringify({ path: "a.txt", content: "1" })), toolStop()]),
    sse([toolChunk("write_file", JSON.stringify({ path: "b.txt", content: "2" })), toolStop()]),
    sse([textChunk("done"), stop()]),
  ]);
  let prompts = 0;
  const agent = new Agent({ provider, model: "m", cwd });
  await agent.send("write two files", {
    onApprove: async () => {
      prompts++;
      return "always";
    },
  });
  assert.equal(prompts, 1, "only the first write should prompt");
});

test("grantAll skips approval entirely", async () => {
  stubBackend([
    sse([toolChunk("run_command", JSON.stringify({ command: "echo hi" })), toolStop()]),
    sse([textChunk("done"), stop()]),
  ]);
  let prompted = false;
  const agent = new Agent({ provider, model: "m", cwd });
  agent.grantAll();
  await agent.send("run it", {
    onApprove: async () => {
      prompted = true;
      return "allow";
    },
  });
  assert.equal(prompted, false);
});

test("an unknown tool is reported back rather than crashing the turn", async () => {
  stubBackend([sse([toolChunk("no_such_tool", "{}"), toolStop()]), sse([textChunk("ok"), stop()])]);
  const agent = new Agent({ provider, model: "m", cwd });
  await agent.send("x", {});
  const second = sent[1] as { messages: { role: string; content?: string }[] };
  assert.match(String(second.messages.find((m) => m.role === "tool")?.content), /no such tool/);
});

test("the loop stops rather than looping forever on a stuck model", async () => {
  // A model that only ever asks for another tool call would otherwise spin.
  stubBackend([sse([toolChunk("read_file", JSON.stringify({ path: "a.txt" })), toolStop()])]);
  const agent = new Agent({ provider, model: "m", cwd, maxSteps: 3 });
  await agent.send("go", {});
  assert.equal(sent.length, 3, "the step ceiling must hold");
});

test("the system prompt states the identity and working directory", () => {
  const p = systemPrompt("/work/project");
  assert.match(p, /O\.S\.C\.A\.R\./);
  assert.match(p, /\/work\/project/);
  assert.doesNotMatch(p, /Claude/i, "the agent's own identity must not name another product");
});

test("reset clears history but keeps the system prompt", async () => {
  stubBackend([sse([textChunk("hi"), stop()])]);
  const agent = new Agent({ provider, model: "m", cwd });
  await agent.send("hello", {});
  assert.ok(agent.length > 1);
  agent.reset();
  assert.equal(agent.length, 1);
});

function existsSyncSafe(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}
