import type { ToolActivityVerb, ToolSurface } from "@playon/agent-core";

export type AgentActivityVerb = ToolActivityVerb;

/** Verbs come from the turn's composed surface — the only place tool metadata lives. */
export function verbForTool(toolName: string, surface: ToolSurface): AgentActivityVerb {
  return surface.activityVerb(toolName);
}

export function labelForTool(toolName: string, verb: AgentActivityVerb): string {
  if (toolName === "panel_list") return "Checking panel…";
  if (toolName === "panel_publish" || toolName.startsWith("panel_")) {
    return "Updating panel…";
  }
  const map: Record<AgentActivityVerb, string> = {
    fetch: "Fetching…",
    search: "Searching…",
    read: "Reading files…",
    write: "Writing…",
    run: "Working on server…",
    snapshot: "Snapshot…",
    panel: "Updating panel…",
    skill: "Working on skill…",
    other: toolName.replace(/_/g, " "),
  };
  return map[verb];
}
