import { AGENT_SYSTEM_PROMPT } from "./agent-prompt.js";
import { runToolInvocation, type ConfirmPolicy, type ToolEntry } from "./invoke-tool.js";
import { looksLikeToolShapedContent, type LlmClient, type LlmMessage } from "./llm.js";
import {
  catalogSystemPrompt,
  isSessionCreatedStop,
  SEQUENTIAL_TOOLS_PROMPT,
  SESSION_CREATE_TOOLS,
  serverIdFromToolResult,
  type ToolCatalogStage,
} from "./tool-catalog.js";
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
  /**
   * Tools were offered, none ran, and the reply looks like a failed tool call.
   * UI may say so; MCP and manual controls still work. Not a model blocklist.
   */
  degradedMode?: boolean;
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
  /** Sanitized later by the control plane — raw next-step prose from this round. */
  onThinking?: (text: string) => void;
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
  /** LLM-facing catalog stage (install/maintain/full). */
  catalogStage?: ToolCatalogStage;
  /**
   * Server ids this chat/session already created. `servers_stop` of these
   * skips the confirm gate (inverse of servers_create_from_skill this turn).
   */
  sessionCreatedServerIds?: Iterable<string>;
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
  private readonly tools = new Map<string, ToolEntry>();
  private readonly sessionCreatedServerIds: Set<string>;
  private boundWorkspaceServerId: string | undefined;

  constructor(
    private readonly llm: LlmClient,
    private readonly options: OrchestratorOptions = {},
  ) {
    this.sessionCreatedServerIds = new Set(options.sessionCreatedServerIds ?? []);
    this.boundWorkspaceServerId = options.workspaceServerId;
  }

  registerTool(def: ToolDefinition, handler: ToolHandler): void {
    this.tools.set(def.name, { def, handler });
  }

  /** Register a colocated entry so confirm copy comes from the tool's own surface. */
  registerEntry(entry: ToolEntry): void {
    this.tools.set(entry.def.name, entry);
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
    const catalogNote = catalogSystemPrompt(this.options.catalogStage ?? "full");
    if (catalogNote) {
      systemMessages.push({ role: "system", content: catalogNote });
    }
    const maxToolCalls =
      this.llm.maxToolCallsPerCompletion && this.llm.maxToolCallsPerCompletion > 0
        ? this.llm.maxToolCallsPerCompletion
        : undefined;
    if (maxToolCalls === 1) {
      systemMessages.push({ role: "system", content: SEQUENTIAL_TOOLS_PROMPT });
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
        const degradedMode =
          toolTrace.length === 0 &&
          Boolean(toolDefs.length) &&
          looksLikeToolShapedContent(completion.content);
        return {
          content: completion.content,
          toolTrace,
          ...(degradedMode ? { degradedMode: true } : {}),
        };
      }

      const toolCalls =
        maxToolCalls && completion.toolCalls.length > maxToolCalls
          ? completion.toolCalls.slice(0, maxToolCalls)
          : completion.toolCalls;

      // Do not stream interim thinking into the assistant bubble — that garbles
      // the final reply. Emit it on the thinking sink so the dock now-line can
      // show a sanitized rationale while tools run.
      const thought = (completion.reasoning ?? completion.content).trim();
      if (thought && !looksLikeToolShapedContent(thought)) {
        stream?.onThinking?.(thought);
      }

      messages.push({
        role: "assistant",
        content: completion.content,
        toolCalls,
      });

      let roundHadFailure = false;

      for (const call of toolCalls) {
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
          const sessionStop = isSessionCreatedStop(
            call.name,
            call.arguments,
            this.sessionCreatedServerIds,
            this.boundWorkspaceServerId,
          );
          result = await runToolInvocation(entry, call.arguments, {
            confirmGate: this.options.confirmGate,
            confirmPolicy: sessionStop ? "auto" : (this.options.confirmPolicy ?? "gate"),
            autoApproveActor: sessionStop
              ? (this.options.autoApproveActor ?? "session:created")
              : this.options.autoApproveActor,
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

        if (!failed && SESSION_CREATE_TOOLS.has(call.name)) {
          const createdId = serverIdFromToolResult(result);
          if (createdId) {
            this.sessionCreatedServerIds.add(createdId);
            this.boundWorkspaceServerId ??= createdId;
          }
        }

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
