import { confirmSummary } from "./confirm-summary.js";
import type { ConfirmGate } from "./orchestrator.js";
import type { ToolDefinition, ToolHandler } from "./tools.js";

/** How confirm-gated tools are approved. */
export type ConfirmPolicy = "gate" | "auto";

export type ToolEntry = {
  def: ToolDefinition;
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
    summary: confirmSummary(entry.def.name, args),
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
