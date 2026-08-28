import type { ToolActivityVerb, ToolSurface } from "@playon/agent-core";
import { nowLineForTool } from "@playon/shared";

export type AgentActivityVerb = ToolActivityVerb;

/** Verbs come from the turn's composed surface — the only place tool metadata lives. */
export function verbForTool(toolName: string, surface: ToolSurface): AgentActivityVerb {
  return surface.activityVerb(toolName);
}

export function labelForTool(
  toolName: string,
  _verb: AgentActivityVerb,
  args?: Record<string, unknown>,
): string {
  return nowLineForTool(toolName, args);
}
