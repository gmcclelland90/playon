import type { Watcher, WatcherAction } from "@playon/shared";
import { isWatcherScriptTool } from "@playon/shared";
import type { ControlPlane } from "../control-plane.js";
import { createPlayOnToolRegistry } from "./tools.js";
import { resolveSystemUserId } from "./agent-turn.js";
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);

  try {
    const result = await plane.agentTurn.run({
      source: "watcher",
      userId,
      prompt: userMessage,
      serverId: watcher.serverId,
      watcherId: watcher.id,
      watcherName: watcher.name,
      abortSignal: controller.signal,
    });
    return {
      ok: true,
      result: {
        conversationId: result.conversationId,
        content: result.reply,
        toolTrace: result.toolTrace,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "agent_failed";
    const conversationId =
      err &&
      typeof err === "object" &&
      "conversationId" in err &&
      typeof (err as { conversationId: unknown }).conversationId === "string"
        ? (err as { conversationId: string }).conversationId
        : undefined;
    return {
      ok: false,
      result: conversationId ? { conversationId } : {},
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}
