// The agent loop: ask the model, run what it asks for, feed the results back,
// repeat until it stops asking. This is the piece that makes O.S.C.A.R. an
// agent rather than a chat window.

import type { Provider } from "../providers.ts";
import { complete, safeArgs, type Message, type ToolCall } from "./client.ts";
import { toolByName, toolSchemas, type Risk, type Tool } from "./tools.ts";

export type Decision = "allow" | "deny" | "always";

export interface AgentEvents {
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  /** Before a tool runs. Return "deny" to refuse it. */
  onApprove?: (tool: Tool, summary: string) => Promise<Decision>;
  /** After a tool runs, with the first line of its result. */
  onToolResult?: (tool: Tool, summary: string, result: string, denied: boolean) => void;
  onTurnEnd?: (usage?: { input: number; output: number }) => void;
}

export interface AgentOptions {
  provider: Provider;
  model: string;
  cwd: string;
  maxTokens?: number | null;
  /** Stops a runaway model burning tokens on an endless tool loop. */
  maxSteps?: number;
  signal?: AbortSignal;
}

export function systemPrompt(cwd: string): string {
  return [
    "You are O.S.C.A.R. (Orchestrator for System Coding & Autonomous Routing), a coding agent working in a terminal.",
    "",
    `Working directory: ${cwd}`,
    "",
    "How to work:",
    "- Read files before editing them. Never guess at contents.",
    "- Prefer edit_file over write_file when changing part of a file.",
    "- Use find_files and search_files to locate things instead of asking the user where they are.",
    "- Run tests or builds with run_command when a change should be verified.",
    "- Take the action rather than describing it. The user sees tool results.",
    "",
    "How to answer:",
    "- Be concise. This is a terminal, not a document.",
    "- Reference files as path:line so they can be opened.",
    "- If a tool fails, read the error and try a different approach rather than repeating it.",
    "- Say plainly when something did not work. Do not claim success you have not verified.",
  ].join("\n");
}

/** Tools whose risk level always needs asking, unless already granted. */
const NEEDS_APPROVAL: Risk[] = ["write", "execute"];

export class Agent {
  private messages: Message[] = [];
  private granted = new Set<string>();

  constructor(private opts: AgentOptions) {
    this.messages.push({ role: "system", content: systemPrompt(opts.cwd) });
  }

  /** Conversation length, for the status display. */
  get length(): number {
    return this.messages.length;
  }

  /** Drop everything but the system prompt. */
  reset(): void {
    this.messages = this.messages.slice(0, 1);
    this.granted.clear();
  }

  /** Pre-approve a risk class for the session (used by --yes). */
  grantAll(): void {
    for (const t of ["write", "execute"]) this.granted.add(t);
  }

  /** Run one user turn to completion, including any tool round-trips. */
  async send(input: string, events: AgentEvents = {}): Promise<void> {
    this.messages.push({ role: "user", content: input });
    const maxSteps = this.opts.maxSteps ?? 24;

    for (let step = 0; step < maxSteps; step++) {
      const turn = await complete({
        provider: this.opts.provider,
        model: this.opts.model,
        messages: this.messages,
        tools: toolSchemas(),
        maxTokens: this.opts.maxTokens,
        signal: this.opts.signal,
        events: { onText: events.onText, onReasoning: events.onReasoning },
      });

      this.messages.push({
        role: "assistant",
        content: turn.text || null,
        ...(turn.toolCalls.length ? { tool_calls: turn.toolCalls } : {}),
      });

      events.onTurnEnd?.(turn.usage);

      if (!turn.toolCalls.length) return; // the model is done talking

      for (const call of turn.toolCalls) {
        const result = await this.runTool(call, events);
        this.messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }

    // Hitting the ceiling is worth saying out loud rather than silently stopping.
    this.messages.push({
      role: "tool",
      tool_call_id: "loop-guard",
      content: `Stopped after ${maxSteps} tool steps. Tell the user what was done and what remains.`,
    });
  }

  private async runTool(call: ToolCall, events: AgentEvents): Promise<string> {
    const tool = toolByName(call.name);
    if (!tool) return `Error: no such tool: ${call.name}`;

    const args = safeArgs(call.arguments);
    const summary = tool.summarise(args);

    if (NEEDS_APPROVAL.includes(tool.risk) && !this.granted.has(tool.risk)) {
      const decision = (await events.onApprove?.(tool, summary)) ?? "allow";
      if (decision === "deny") {
        events.onToolResult?.(tool, summary, "denied by user", true);
        return "The user declined this action. Do not retry it; ask what they would prefer.";
      }
      if (decision === "always") this.granted.add(tool.risk);
    }

    let result: string;
    try {
      result = await tool.run(args, this.opts.cwd);
    } catch (err) {
      result = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    events.onToolResult?.(tool, summary, result, false);
    return result;
  }
}
