import { confirmSummary } from "./confirm-summary.js";
import type { ConfirmGate } from "./orchestrator.js";
import type { ToolSurfaceMeta, ToolWorkspacePolicy } from "./tool-surface.js";
import type { ToolDefinition, ToolHandler } from "./tools.js";

/** How confirm-gated tools are approved. */
export type ConfirmPolicy = "gate" | "auto";

/** One tool: LLM definition, colocated surface metadata, workspace scope, handler. */
export type ToolEntry = {
  def: ToolDefinition;
  /** Skill / confirm copy / activity verb / XP for this tool. */
  surface?: ToolSurfaceMeta;
  /** Declared scope; the composing registry resolves it before calling the handler. */
  workspacePolicy?: ToolWorkspacePolicy;
  /**
   * Runs before confirm. Return an error object to abort (workspace/session
   * targeting). Confirm must not fire for a friend/live server the session
   * is not allowed to touch.
   */
  preflight?: (args: Record<string, unknown>) => Record<string, unknown> | null;
  handler: ToolHandler;
};

/**
 * Shared tool execution for Orchestrator (Venice/Ollama) and MCP.
 * Confirm policy must not diverge across entry points.
 */
export async function runToolInvocation(
  entry: ToolEntry,
  args: Record<string, unknown>,
  options: {
    confirmGate?: ConfirmGate;
    confirmPolicy?: ConfirmPolicy;
    /** Logged when confirmPolicy is auto (e.g. token id). */
    autoApproveActor?: string;
  } = {},
): Promise<unknown> {
  const confirmPolicy = options.confirmPolicy ?? "gate";

  if (entry.preflight) {
    const blocked = entry.preflight(args);
    if (blocked) return blocked;
  }

  if (!entry.def.requiresConfirm) {
    return entry.handler(args);
  }

  if (confirmPolicy === "auto") {
    const result = await entry.handler(args);
    if (result && typeof result === "object") {
      return {
        ...(result as object),
        confirmAutoApproved: true,
        confirmActor: options.autoApproveActor ?? "auto",
      };
    }
    return result;
  }

  const gate = options.confirmGate;
  if (!gate) {
    return {
      error: "confirm_required",
      detail: "host_confirm_gate_unavailable",
      toolName: entry.def.name,
    };
  }

  const decision = await gate.requestConfirmation({
    toolName: entry.def.name,
    summary: confirmSummary(entry.def.name, args, { action: entry.surface?.confirmAction }),
    arguments: args,
  });
  if (!decision.approved) {
    return {
      error: "confirm_denied",
      requestId: decision.requestId,
      toolName: entry.def.name,
    };
  }

  const result = await entry.handler(args);
  if (result && typeof result === "object") {
    return { ...(result as object), confirmRequestId: decision.requestId };
  }
  return result;
}
