/**
 * Control-plane AgentTurn — single choke for Canvas chat and watcher `kind: "agent"`.
 *
 * Owns conversation bind/load/persist, LLM+orchestrator run, activity stream,
 * confirm wiring, tool audit, XP/celebrations, and abort. Out: MCP, tool handlers,
 * LLM client internals, ConfirmService/EventHub implementations.
 */
import { asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type {
  ChatStreamSink,
  ConfirmGate,
  LlmClient,
  LlmMessage,
  OrchestratorResult,
  ToolTraceEntry,
} from "@playon/agent-core";
import { ChatAbortedError } from "@playon/agent-core";
import { HttpError, messageFromError } from "@playon/shared";
import type { ControlPlane } from "../control-plane.js";
import { conversations, messages, toolInvocations, users } from "../db/schema.js";
import { labelForTool, verbForTool } from "./agent-activity.js";
import { redactJson, redactString } from "./redaction.js";
import { getSetting, LLM_SETTINGS_KEY, type LlmSettings } from "./settings.js";
import {
  createLlmClient,
  createOrchestrator,
  createPlayOnToolSurface,
} from "./tools.js";

const CREATE_BIND_TOOLS = new Set([
  "servers_create_from_skill",
  "servers_import_local",
  "servers_import_sftp",
]);

/** Prefer create/import tool results when binding an unbound install conversation. */
export function serverIdFromCreateTrace(
  toolTrace: Array<{ name: string; result?: unknown }>,
): string | undefined {
  for (const trace of toolTrace) {
    if (!CREATE_BIND_TOOLS.has(trace.name)) continue;
    const result = trace.result;
    if (!result || typeof result !== "object") continue;
    const rec = result as Record<string, unknown>;
    if (typeof rec.error === "string") continue;
    if (typeof rec.serverId === "string" && rec.serverId) return rec.serverId;
    const nested = rec.server;
    if (nested && typeof nested === "object") {
      const id = (nested as { id?: unknown }).id;
      if (typeof id === "string" && id) return id;
    }
  }
  return undefined;
}

export type AgentTurnChatInput = {
  source: "chat";
  userId: string;
  prompt: string;
  conversationId?: string;
  serverId?: string;
  abortSignal: AbortSignal;
};

export type AgentTurnWatcherInput = {
  source: "watcher";
  userId: string | null;
  prompt: string;
  serverId: string;
  watcherId: string;
  watcherName: string;
  abortSignal: AbortSignal;
};

export type AgentTurnInput = AgentTurnChatInput | AgentTurnWatcherInput;

export type AgentTurnCelebration = {
  serverId: string;
  skill: string;
  reason: string;
  xpGained: number;
  level: number;
  title: string;
  leveledUp: boolean;
};

export type AgentTurnResult = {
  conversationId: string;
  serverId?: string;
  reply: string;
  toolTrace: ToolTraceEntry[];
  aborted?: boolean;
  llmMode?: string;
  /** Tools were offered but the model printed tool-shaped text instead of calling them. */
  degradedMode?: boolean;
  agentProgress?: {
    skill: string;
    xp: number;
    level: number;
    title: string;
  };
  celebrations?: AgentTurnCelebration[];
};

export type AgentTurnErrorCode =
  | "conversation_not_found"
  | "server_not_found"
  | "serverId_mismatch"
  | "llm_api_key_required"
  | "chat_failed";

export class AgentTurnError extends Error {
  readonly code: AgentTurnErrorCode;

  constructor(code: AgentTurnErrorCode, message?: string, options?: { cause?: unknown }) {
    super(message ?? code, options);
    this.name = "AgentTurnError";
    this.code = code;
  }
}

/** Map turn errors to the stable chat HTTP envelope. */
export function agentTurnHttpError(err: AgentTurnError): HttpError {
  switch (err.code) {
    case "conversation_not_found":
      return HttpError.notFound("conversation_not_found", { code: "conversation_not_found" });
    case "server_not_found":
      return HttpError.notFound("server_not_found", { code: "server_not_found" });
    case "serverId_mismatch":
      return HttpError.badRequest("serverId_mismatch", { code: "serverId_mismatch" });
    case "llm_api_key_required":
      return new HttpError(400, err.message, {
        code: "llm_api_key_required",
        cause: err.cause,
      });
    case "chat_failed":
      return new HttpError(502, err.message, { code: "chat_failed", cause: err.cause });
  }
}

export type AgentTurnDeps = {
  /** Test seam — production uses createLlmClient. */
  createLlmClient?: (plane: ControlPlane) => Promise<LlmClient>;
};

type ActivityPhase =
  | "thinking"
  | "tool_start"
  | "tool_done"
  | "tool_fail"
  | "confirm_wait"
  | "idle";

export class AgentTurn {
  constructor(
    private readonly plane: ControlPlane,
    private readonly deps: AgentTurnDeps = {},
  ) {}

  async run(input: AgentTurnInput): Promise<AgentTurnResult> {
    const plane = this.plane;
    const now = new Date();
    const isChat = input.source === "chat";

    let conversationId: string;
    let workspaceServerId: string | undefined;
    let priorMessages: LlmMessage[] = [];

    if (isChat) {
      const bound = await this.bindChatConversation(input, now);
      conversationId = bound.conversationId;
      workspaceServerId = bound.workspaceServerId;
      priorMessages = bound.priorMessages;
    } else {
      conversationId = nanoid();
      workspaceServerId = input.serverId;
      await this.persistWatcherConversation(input, conversationId, now);
    }

    const toolSurface = createPlayOnToolSurface(plane, { workspaceServerId });
    let activityServerId = workspaceServerId;
    let activitySkill = isChat ? "orchestrator" : "monitor";

    const publishActivity = (
      phase: ActivityPhase,
      opts?: {
        toolName?: string;
        verb?: ReturnType<typeof verbForTool>;
        label?: string;
        skill?: string;
      },
    ) => {
      if (isChat && !activityServerId) return;
      const serverId = activityServerId ?? (isChat ? undefined : input.serverId);
      if (!serverId) return;

      if (isChat) {
        const verb = opts?.verb ?? "other";
        if (opts?.skill) activitySkill = opts.skill;
        else if (opts?.toolName) activitySkill = toolSurface.skill(opts.toolName);
        plane.eventHub.publish({
          type: "agent.activity",
          serverId,
          conversationId,
          skill: activitySkill,
          phase,
          verb,
          toolName: opts?.toolName,
          label:
            opts?.label ??
            (phase === "thinking"
              ? "Thinking…"
              : phase === "idle"
                ? "Idle"
                : phase === "confirm_wait"
                  ? "Waiting for confirm…"
                  : undefined),
        });
        return;
      }

      const toolName = opts?.toolName;
      const verb = toolName ? verbForTool(toolName, toolSurface) : "run";
      plane.eventHub.publish({
        type: "agent.activity",
        serverId,
        conversationId,
        skill: "monitor",
        phase,
        verb,
        toolName,
        label:
          opts?.label ??
          (toolName ? labelForTool(toolName, verb) : input.watcherName),
      });
    };

    const abortSignal = input.abortSignal;
    let streamedReply = "";
    const onClientAbort = () => {
      if (isChat) plane.confirm.cancelAll();
    };
    if (isChat) {
      abortSignal.addEventListener("abort", onClientAbort, { once: true });
    }

    try {
      const createLlm =
        this.deps.createLlmClient ?? ((p) => createLlmClient(p.db, p.config));
      const llm = await createLlm(plane);

      const confirmGate: ConfirmGate | undefined = isChat
        ? {
            requestConfirmation: async (request) => {
              publishActivity("confirm_wait", {
                toolName: request.toolName,
                verb: verbForTool(request.toolName, toolSurface),
                label: "Waiting for confirm…",
              });
              try {
                return await plane.confirm.requestConfirmation(request);
              } finally {
                publishActivity("thinking", { label: "Thinking…", verb: "other" });
              }
            },
          }
        : undefined;

      const stream: ChatStreamSink = {
        conversationId,
        onToken: (token) => {
          if (!isChat) return;
          streamedReply += token;
          plane.eventHub.publish({ type: "chat.token", conversationId, token });
        },
        onTool: ({ toolName, status, detail }) => {
          if (isChat) {
            plane.eventHub.publish({
              type: "chat.tool",
              conversationId,
              toolName,
              status,
              detail,
            });
            if (
              status === "completed" &&
              detail &&
              typeof detail.serverId === "string" &&
              detail.serverId &&
              !activityServerId
            ) {
              activityServerId = detail.serverId;
            }
            const verb = verbForTool(toolName, toolSurface);
            const phase: ActivityPhase =
              status === "started"
                ? "tool_start"
                : status === "failed"
                  ? "tool_fail"
                  : "tool_done";
            publishActivity(phase, {
              toolName,
              verb,
              label: labelForTool(toolName, verb),
            });
            if (status === "completed" || status === "failed") {
              publishActivity("thinking", { label: "Thinking…", verb: "other" });
            }
            return;
          }

          if (status === "started") {
            publishActivity("tool_start", { toolName });
          } else if (status === "failed") {
            publishActivity("tool_fail", { toolName });
          } else {
            publishActivity("tool_done", { toolName });
          }
        },
      };

      const orchestrator = createOrchestrator(plane, llm, {
        confirmGate,
        workspaceServerId,
        abortSignal,
        confirmPolicy: isChat ? "gate" : "auto",
        autoApproveActor: isChat ? undefined : `watcher:${input.watcherId}`,
        stream,
      });

      publishActivity("thinking");
      const result = await orchestrator.handle(input.prompt, priorMessages);

      if (isChat) {
        return await this.finishChatTurn({
          userId: input.userId,
          conversationId,
          workspaceServerId,
          result,
          toolSurface,
          setActivityServerId: (id) => {
            activityServerId = id;
          },
        });
      }

      await this.persistAssistantBestEffort(input.userId, conversationId, result.content);
      return {
        conversationId,
        serverId: workspaceServerId,
        reply: result.content,
        toolTrace: result.toolTrace,
        degradedMode: result.degradedMode,
      };
    } catch (err) {
      const aborted =
        err instanceof ChatAbortedError ||
        abortSignal.aborted ||
        (err instanceof Error && err.name === "AbortError");

      if (aborted && isChat) {
        plane.confirm.cancelAll();
        const safeReply = redactString(streamedReply.trim() || "Stopped.");
        await plane.db.insert(messages).values({
          id: nanoid(),
          conversationId,
          role: "assistant",
          content: safeReply,
          createdAt: new Date(),
        });
        return {
          conversationId,
          serverId: workspaceServerId,
          reply: safeReply,
          toolTrace: [],
          aborted: true,
          llmMode: plane.config.llmMode,
        };
      }

      if (isChat) {
        const messageText = messageFromError(err, "chat_failed");
        const needsKey = messageText.includes("llm_api_key_required");
        throw new AgentTurnError(
          needsKey ? "llm_api_key_required" : "chat_failed",
          messageText,
          { cause: err },
        );
      }

      const message = err instanceof Error ? err.message : "agent_failed";
      const wrapped = new Error(message, { cause: err }) as Error & {
        conversationId: string;
      };
      wrapped.conversationId = conversationId;
      throw wrapped;
    } finally {
      if (isChat) {
        abortSignal.removeEventListener("abort", onClientAbort);
      }
      publishActivity("idle");
    }
  }

  private async bindChatConversation(
    input: AgentTurnChatInput,
    now: Date,
  ): Promise<{
    conversationId: string;
    workspaceServerId: string | undefined;
    priorMessages: LlmMessage[];
  }> {
    let conversationId = input.conversationId;
    let workspaceServerId: string | undefined = input.serverId;

    if (conversationId) {
      const existing = await this.plane.db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);
      const conversation = existing[0];
      if (!conversation || conversation.userId !== input.userId) {
        throw new AgentTurnError("conversation_not_found");
      }
      if (input.serverId && conversation.serverId && input.serverId !== conversation.serverId) {
        throw new AgentTurnError("serverId_mismatch");
      }
      workspaceServerId = conversation.serverId ?? input.serverId;
      await this.plane.db
        .update(conversations)
        .set({ updatedAt: now })
        .where(eq(conversations.id, conversationId));
    } else {
      if (input.serverId) {
        const server = await this.plane.servers.get(input.serverId);
        if (!server) {
          throw new AgentTurnError("server_not_found");
        }
        workspaceServerId = input.serverId;
      } else {
        workspaceServerId = undefined;
      }
      conversationId = nanoid();
      await this.plane.db.insert(conversations).values({
        id: conversationId,
        userId: input.userId,
        serverId: workspaceServerId,
        title: input.prompt.slice(0, 80),
        createdAt: now,
        updatedAt: now,
      });
    }

    const priorRows = await this.plane.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt));

    const priorMessages: LlmMessage[] = priorRows
      .filter((row) => row.role === "user" || row.role === "assistant")
      .map((row) => ({
        role: row.role as "user" | "assistant",
        content: row.content,
      }));

    await this.plane.db.insert(messages).values({
      id: nanoid(),
      conversationId,
      role: "user",
      content: input.prompt,
      createdAt: now,
    });

    return { conversationId, workspaceServerId, priorMessages };
  }

  private async persistWatcherConversation(
    input: AgentTurnWatcherInput,
    conversationId: string,
    now: Date,
  ): Promise<void> {
    if (!input.userId) return;
    try {
      await this.plane.db.insert(conversations).values({
        id: conversationId,
        userId: input.userId,
        serverId: input.serverId,
        title: `Watcher · ${input.watcherName}`,
        createdAt: now,
        updatedAt: now,
      });
      await this.plane.db.insert(messages).values({
        id: nanoid(),
        conversationId,
        role: "user",
        content: input.prompt,
        createdAt: now,
      });
    } catch {
      // audit conversation is best-effort
    }
  }

  private async persistAssistantBestEffort(
    userId: string | null,
    conversationId: string,
    content: string,
  ): Promise<void> {
    if (!userId) return;
    try {
      await this.plane.db.insert(messages).values({
        id: nanoid(),
        conversationId,
        role: "assistant",
        content,
        createdAt: new Date(),
      });
    } catch {
      // best-effort
    }
  }

  private async finishChatTurn(args: {
    userId: string;
    conversationId: string;
    workspaceServerId: string | undefined;
    result: OrchestratorResult;
    toolSurface: ReturnType<typeof createPlayOnToolSurface>;
    setActivityServerId: (id: string) => void;
  }): Promise<AgentTurnResult> {
    const {
      userId,
      conversationId,
      workspaceServerId,
      result,
      toolSurface,
      setActivityServerId,
    } = args;

    for (const trace of result.toolTrace) {
      const failed =
        trace.result &&
        typeof trace.result === "object" &&
        ("error" in (trace.result as object) ||
          (trace.result as { ok?: boolean }).ok === false);
      await this.plane.db.insert(toolInvocations).values({
        id: nanoid(),
        conversationId,
        userId,
        toolName: trace.name,
        argsJson: redactJson(trace.arguments),
        resultJson: redactJson(trace.result),
        status: failed ? "error" : "ok",
        createdAt: new Date(),
      });
    }

    const createdServerId = serverIdFromCreateTrace(result.toolTrace);
    let boundServerId = workspaceServerId ?? createdServerId;
    if (!workspaceServerId && createdServerId) {
      await this.plane.db
        .update(conversations)
        .set({ serverId: createdServerId, updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
      boundServerId = createdServerId;
      setActivityServerId(createdServerId);
    }

    const awards = boundServerId
      ? await this.plane.agentProgress.awardForTools(result.toolTrace, toolSurface)
      : [];
    const celebrations = awards.filter((a) => a.celebrate);
    for (const award of celebrations) {
      this.plane.eventHub.publish({
        type: "agent.celebration",
        serverId: boundServerId!,
        skill: award.skill,
        reason: award.reason,
        xpGained: award.xpGained,
        level: award.progress.level,
        title: award.progress.title,
        leveledUp: award.leveledUp,
      });
    }

    const safeReply = redactString(result.content);
    await this.plane.db.insert(messages).values({
      id: nanoid(),
      conversationId,
      role: "assistant",
      content: safeReply,
      createdAt: new Date(),
    });

    const stored = await getSetting<LlmSettings>(this.plane.db, LLM_SETTINGS_KEY);
    const lastAward = awards.length ? awards[awards.length - 1] : undefined;

    return {
      conversationId,
      serverId: boundServerId,
      reply: safeReply,
      llmMode: stored?.provider ?? this.plane.config.llmMode,
      toolTrace: result.toolTrace,
      degradedMode: result.degradedMode,
      agentProgress: lastAward
        ? {
            skill: lastAward.progress.skill,
            xp: lastAward.progress.xp,
            level: lastAward.progress.level,
            title: lastAward.progress.title,
          }
        : undefined,
      celebrations: celebrations.map((a) => ({
        serverId: boundServerId!,
        skill: a.skill,
        reason: a.reason,
        xpGained: a.xpGained,
        level: a.progress.level,
        title: a.progress.title,
        leveledUp: a.leveledUp,
      })),
    };
  }
}

export async function resolveSystemUserId(plane: ControlPlane): Promise<string | null> {
  const rows = await plane.db.select().from(users).orderBy(asc(users.createdAt)).limit(1);
  return rows[0]?.id ?? null;
}
