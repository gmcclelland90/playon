import { nanoid } from "nanoid";
import type { Watcher, WatcherAction } from "@playon/shared";
import { isWatcherScriptTool } from "@playon/shared";
import type { ControlPlane } from "../control-plane.js";
import { conversations, messages } from "../db/schema.js";
import { labelForTool, verbForTool } from "./agent-activity.js";
import {
  createLlmClient,
  createOrchestrator,
  createPlayOnToolRegistry,
  createPlayOnToolSurface,
} from "./tools.js";
import {
  buildWatcherContext,
  type WatcherLogBuffer,
} from "./watcher-context.js";

const AGENT_TIMEOUT_MS = 180_000;

export type WatcherActionResult = {
  ok: boolean;
  result: Record<string, unknown>;
  error?: string;
};

export async function runWatcherAction(
  plane: ControlPlane,
  watcher: Watcher,
  logBuffer: WatcherLogBuffer,
  triggerPayload: Record<string, unknown>,
): Promise<WatcherActionResult> {
  if (watcher.action.kind === "tools") {
    return runToolScript(plane, watcher, watcher.action);
  }
  return runAgentTurn(plane, watcher, logBuffer, triggerPayload, watcher.action);
}

async function runToolScript(
  plane: ControlPlane,
  watcher: Watcher,
  action: Extract<WatcherAction, { kind: "tools" }>,
): Promise<WatcherActionResult> {
  const { registry } = createPlayOnToolRegistry(plane, {
    workspaceServerId: watcher.serverId,
  });
  const actor = `watcher:${watcher.id}`;
  const steps: Array<{ tool: string; ok: boolean; result: unknown }> = [];

  for (const step of action.steps) {
    if (!isWatcherScriptTool(step.tool)) {
      const err = `tool_not_allowed: ${step.tool}`;
      steps.push({ tool: step.tool, ok: false, result: { error: err } });
      if (!action.continueOnError) {
        return { ok: false, result: { steps }, error: err };
      }
      continue;
    }
    const args = {
      ...step.args,
      serverId: step.args.serverId ?? watcher.serverId,
    };
    const result = await registry.invoke(step.tool, args, {
      confirmPolicy: "auto",
      autoApproveActor: actor,
    });
    const failed =
      result &&
      typeof result === "object" &&
      typeof (result as { error?: unknown }).error === "string";
    steps.push({ tool: step.tool, ok: !failed, result });
    if (failed && !action.continueOnError) {
      return {
        ok: false,
        result: { steps },
        error: String((result as { error: string }).error),
      };
    }
  }

  const ok = steps.every((s) => s.ok);
  return {
    ok,
    result: { steps },
    error: ok ? undefined : "tool_script_failed",
  };
}

async function runAgentTurn(
  plane: ControlPlane,
  watcher: Watcher,
  logBuffer: WatcherLogBuffer,
  triggerPayload: Record<string, unknown>,
  action: Extract<WatcherAction, { kind: "agent" }>,
): Promise<WatcherActionResult> {
  const llm = await createLlmClient(plane.db, plane.config);
  const conversationId = nanoid();
  const now = new Date();
  const userId = await resolveSystemUserId(plane);

  let contextBlock = "";
  if (action.includeContext) {
    const ctx = await buildWatcherContext(plane, watcher.serverId, logBuffer);
    contextBlock = `\nContext:\n${JSON.stringify(ctx, null, 2)}\n`;
  }
  const userMessage = [
    `[Watcher: ${watcher.name}]`,
    `Trigger: ${JSON.stringify(triggerPayload)}`,
    contextBlock,
    "Task:",
    action.prompt,
  ].join("\n");

  if (userId) {
    try {
      await plane.db.insert(conversations).values({
        id: conversationId,
        userId,
        serverId: watcher.serverId,
        title: `Watcher · ${watcher.name}`,
        createdAt: now,
        updatedAt: now,
      });
      await plane.db.insert(messages).values({
        id: nanoid(),
        conversationId,
        role: "user",
        content: userMessage,
        createdAt: now,
      });
    } catch {
      // audit conversation is best-effort
    }
  }

  const toolSurface = createPlayOnToolSurface(plane, { workspaceServerId: watcher.serverId });

  const publishActivity = (
    phase:
      | "thinking"
      | "tool_start"
      | "tool_done"
      | "tool_fail"
      | "confirm_wait"
      | "idle",
    extra?: { toolName?: string; label?: string },
  ) => {
    const toolName = extra?.toolName;
    const verb = toolName ? verbForTool(toolName, toolSurface) : "run";
    plane.eventHub.publish({
      type: "agent.activity",
      serverId: watcher.serverId,
      conversationId,
      skill: "monitor",
      phase,
      verb,
      toolName,
      label: extra?.label ?? (toolName ? labelForTool(toolName, verb) : watcher.name),
    });
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
  publishActivity("thinking");

  try {
    const orchestrator = createOrchestrator(plane, llm, {
      workspaceServerId: watcher.serverId,
      confirmPolicy: "auto",
      autoApproveActor: `watcher:${watcher.id}`,
      abortSignal: controller.signal,
      stream: {
        conversationId,
        onToken: () => undefined,
        onTool: (info) => {
          if (info.status === "started") {
            publishActivity("tool_start", { toolName: info.toolName });
          } else if (info.status === "failed") {
            publishActivity("tool_fail", { toolName: info.toolName });
          } else {
            publishActivity("tool_done", { toolName: info.toolName });
          }
        },
      },
    });

    const result = await orchestrator.handle(userMessage, []);
    if (userId) {
      try {
        await plane.db.insert(messages).values({
          id: nanoid(),
          conversationId,
          role: "assistant",
          content: result.content,
          createdAt: new Date(),
        });
      } catch {
        // best-effort
      }
    }

    return {
      ok: true,
      result: {
        conversationId,
        content: result.content,
        toolTrace: result.toolTrace,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "agent_failed";
    return {
      ok: false,
      result: { conversationId },
      error: message,
    };
  } finally {
    clearTimeout(timer);
    publishActivity("idle");
  }
}

async function resolveSystemUserId(plane: ControlPlane): Promise<string | null> {
  const { users } = await import("../db/schema.js");
  const { asc } = await import("drizzle-orm");
  const rows = await plane.db.select().from(users).orderBy(asc(users.createdAt)).limit(1);
  return rows[0]?.id ?? null;
}
