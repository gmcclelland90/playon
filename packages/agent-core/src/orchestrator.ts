import { AGENT_SYSTEM_PROMPT } from "./agent-prompt.js";
import { runToolInvocation, type ConfirmPolicy } from "./invoke-tool.js";
import type { LlmClient, LlmMessage } from "./llm.js";
import { toLlmToolDefinition, type ToolDefinition, type ToolHandler } from "./tools.js";

export { confirmActionLabel, confirmSummary } from "./confirm-summary.js";
export { runToolInvocation, type ConfirmPolicy, type ToolEntry } from "./invoke-tool.js";

export interface ToolTraceEntry {
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

export interface OrchestratorResult {
  content: string;
  toolTrace: ToolTraceEntry[];
}

export interface ConfirmRequest {
  requestId: string;
  toolName: string;
  summary: string;
  arguments: Record<string, unknown>;
}

/** Host confirmation gate (plan: host.confirm). */
export interface ConfirmGate {
  requestConfirmation(request: Omit<ConfirmRequest, "requestId">): Promise<{
    requestId: string;
    approved: boolean;
  }>;
}

export interface ChatStreamSink {
  conversationId: string;
  onToken: (token: string) => void;
  onTool: (info: {
    toolName: string;
    status: "started" | "completed" | "failed";
    detail?: Record<string, unknown>;
  }) => void;
}

export interface OrchestratorOptions {
  confirmGate?: ConfirmGate;
  stream?: ChatStreamSink;
  /** When set, agents operate inside this server workspace. */
  workspaceServerId?: string;
  /** When aborted, stop between LLM/tool steps (in-flight tool may finish). */
  abortSignal?: AbortSignal;
  /** Default gate (chat). Watchers / trusted automation may use auto. */
  confirmPolicy?: ConfirmPolicy;
  /** Actor label when confirmPolicy is auto (e.g. watcher:id). */
  autoApproveActor?: string;
}

/** Thrown when the host stops an in-flight chat turn. */
export class ChatAbortedError extends Error {
  constructor(message = "chat_aborted") {
    super(message);
    this.name = "ChatAbortedError";
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ChatAbortedError();
}

function emitContentTokens(stream: ChatStreamSink | undefined, content: string): void {
  if (!stream || !content) return;
  const parts = content.split(/(\s+)/);
  for (const part of parts) {
    if (part) stream.onToken(part);
  }
}

export function workspaceSystemPrompt(serverId: string): string {
  return [
    `You are working inside PlayOn server workspace workspaceServerId=${serverId}.`,
    "All server-scoped tools default to this server. Do not target other serverIds.",
    "Prefer configuring, starting, stopping, and publishing the panel for this workspace server.",
    "Do not create a sibling server. If you need to start over, call servers_create_from_skill again — it wipes and reinstalls this same server id, then servers_start and panel_publish.",
  ].join(" ");
}

/**
 * LLM rounds that may include tool calls (each round may batch several tools).
 * Happy-path install should finish in ~4–6; headroom covers confirm gates + one recovery.
 */
const MAX_TOOL_ITERATIONS = 24;

const RESUME_USER_RE =
  /^(continue|resume|keep going|go ahead|go on|proceed)([.!?]|\s+please)?$/i;

const RESUME_SYSTEM_PROMPT = [
  "The host asked to resume unfinished work from this conversation.",
  "Finish their stated task with the fewest tools. Prefer skill_read + targeted fs_* / restart over broad directory walks.",
  "Do not blindly servers_start + panel_publish if the task is already done or verified. Do not draft/promote skills or fetch Workshop HTML unless the task requires it.",
].join(" ");

const SELF_HEAL_SYSTEM_PROMPT = [
  "A tool just failed. Self-heal: read the error/hint, correct the approach once (different args, alternate skill/command, or a targeted inspect), then finish or explain clearly.",
  "Do not repeat the same failing tool call with the same arguments.",
].join(" ");

export function toolResultFailed(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const rec = result as Record<string, unknown>;
  if (typeof rec.error === "string" && rec.error) return true;
  if (rec.ok === false) return true;
  return false;
}

function toolCallKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(args)}`;
}

function countFailedIdenticalCalls(
  toolTrace: ToolTraceEntry[],
  name: string,
  args: Record<string, unknown>,
): number {
  const key = toolCallKey(name, args);
  return toolTrace.filter(
    (t) => toolCallKey(t.name, t.arguments) === key && toolResultFailed(t.result),
  ).length;
}

function summarizeMaxIterations(toolTrace: ToolTraceEntry[]): string {
  const names = [...new Set(toolTrace.map((t) => t.name))];
  const created = toolTrace.some(
    (t) =>
      t.name === "servers_create_from_skill" &&
      !(t.result && typeof t.result === "object" && "error" in (t.result as object)),
  );
  const started = toolTrace.some(
    (t) =>
      t.name === "servers_start" &&
      !(t.result && typeof t.result === "object" && "error" in (t.result as object)),
  );
  const panelled = toolTrace.some((t) => t.name === "panel_publish");
  const lines = [
    "I hit the tool step limit before finishing a final reply.",
    names.length ? `Tools used: ${names.join(", ")}.` : null,
    created && !started
      ? "A server was created but not started — say **continue** and I will start it and publish join/setup for players."
      : null,
    started && !panelled
      ? "The server was started but the player panel may be incomplete — say **continue** to publish join + client setup."
      : null,
    !created
      ? "Say **continue** to resume, or tell me which game/skill to use."
      : null,
  ].filter(Boolean);
  return lines.join("\n");
}

export class Orchestrator {
  private readonly tools = new Map<string, { def: ToolDefinition; handler: ToolHandler }>();

  constructor(
    private readonly llm: LlmClient,
    private readonly options: OrchestratorOptions = {},
  ) {}

  registerTool(def: ToolDefinition, handler: ToolHandler): void {
    this.tools.set(def.name, { def, handler });
  }

  getToolDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.def);
  }

  async handle(
    userMessage: string,
    priorMessages: LlmMessage[] = [],
  ): Promise<OrchestratorResult> {
    const history = priorMessages.filter(
      (m) => m.role === "user" || m.role === "assistant" || m.role === "tool",
    );
    const systemMessages: LlmMessage[] = [
      { role: "system", content: AGENT_SYSTEM_PROMPT },
    ];
    if (this.options.workspaceServerId) {
      systemMessages.push({
        role: "system",
        content: workspaceSystemPrompt(this.options.workspaceServerId),
      });
    }
    if (RESUME_USER_RE.test(userMessage.trim())) {
      systemMessages.push({ role: "system", content: RESUME_SYSTEM_PROMPT });
    }
    const messages: LlmMessage[] = [
      ...systemMessages,
      ...history,
      { role: "user", content: userMessage },
    ];
    const toolTrace: ToolTraceEntry[] = [];
    const toolDefs = this.getToolDefinitions().map(toLlmToolDefinition);

    const stream = this.options.stream;
    const abortSignal = this.options.abortSignal;
    let selfHealNudged = false;

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      throwIfAborted(abortSignal);
      let completion;
      try {
        completion = await this.llm.complete(
          messages,
          toolDefs.length ? toolDefs : undefined,
          { signal: abortSignal },
        );
      } catch (err) {
        if (abortSignal?.aborted || (err instanceof Error && err.name === "AbortError")) {
          throw new ChatAbortedError();
        }
        throw err;
      }

      if (!completion.toolCalls?.length) {
        emitContentTokens(stream, completion.content);
        return { content: completion.content, toolTrace };
      }

      // Do not stream interim "thinking" text that accompanies tool calls — models often
      // restate the plan each round, and concatenating those fragments garbles the UI.
      messages.push({
        role: "assistant",
        content: completion.content,
        toolCalls: completion.toolCalls,
      });

      let roundHadFailure = false;

      for (const call of completion.toolCalls) {
        throwIfAborted(abortSignal);
        const entry = this.tools.get(call.name);
        stream?.onTool({
          toolName: call.name,
          status: "started",
          detail: { arguments: call.arguments },
        });

        if (!entry) {
          const err = { error: `unknown_tool: ${call.name}` };
          toolTrace.push({ name: call.name, arguments: call.arguments, result: err });
          stream?.onTool({ toolName: call.name, status: "failed", detail: err });
          messages.push({
            role: "tool",
            name: call.name,
            content: JSON.stringify(err),
            toolCallId: call.id,
          });
          roundHadFailure = true;
          continue;
        }

        if (countFailedIdenticalCalls(toolTrace, call.name, call.arguments) >= 1) {
          const err = {
            error: "repeated_failing_tool_call",
            toolName: call.name,
            hint: "This exact tool call already failed. Self-heal with a different command/args, inspect once, or explain to the host.",
          };
          toolTrace.push({ name: call.name, arguments: call.arguments, result: err });
          stream?.onTool({ toolName: call.name, status: "failed", detail: err });
          messages.push({
            role: "tool",
            name: call.name,
            content: JSON.stringify(err),
            toolCallId: call.id,
          });
          roundHadFailure = true;
          continue;
        }

        let result: unknown;
        let failed = false;
        try {
          result = await runToolInvocation(entry, call.arguments, {
            confirmGate: this.options.confirmGate,
            confirmPolicy: this.options.confirmPolicy ?? "gate",
            autoApproveActor: this.options.autoApproveActor,
          });
          if (
            result &&
            typeof result === "object" &&
            typeof (result as { error?: unknown }).error === "string" &&
            ((result as { error: string }).error === "confirm_denied" ||
              (result as { error: string }).error === "confirm_required")
          ) {
            failed = true;
          }
        } catch (err) {
          failed = true;
          result = { error: err instanceof Error ? err.message : "tool_failed" };
        }

        if (!failed && toolResultFailed(result)) failed = true;
        if (failed) roundHadFailure = true;

        toolTrace.push({ name: call.name, arguments: call.arguments, result });
        stream?.onTool({
          toolName: call.name,
          status: failed ? "failed" : "completed",
          detail: typeof result === "object" && result ? (result as Record<string, unknown>) : undefined,
        });
        messages.push({
          role: "tool",
          name: call.name,
          content: JSON.stringify(result),
          toolCallId: call.id,
        });
      }

      if (roundHadFailure && !selfHealNudged) {
        selfHealNudged = true;
        messages.push({ role: "system", content: SELF_HEAL_SYSTEM_PROMPT });
      }
    }

    const stopped = summarizeMaxIterations(toolTrace);
    emitContentTokens(stream, stopped);
    return {
      content: stopped,
      toolTrace,
    };
  }
}
