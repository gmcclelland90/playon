import type { ToolDefinition } from "./tools.js";

/** Fun leveling tracks for the single PlayOn agent (not separate actors). */
export type AgentSkill =
  | "orchestrator"
  | "installer"
  | "player_panel"
  | "modder"
  | "configurer"
  | "troubleshooter"
  | "monitor"
  | "backup";

export const AGENT_SKILLS = [
  "installer",
  "monitor",
  "configurer",
  "troubleshooter",
  "backup",
  "player_panel",
  "modder",
  "orchestrator",
] as const satisfies readonly AgentSkill[];

const SKILL_LABELS: Record<AgentSkill, string> = {
  installer: "Install",
  monitor: "Monitor",
  configurer: "Config",
  troubleshooter: "Fix",
  backup: "Backup",
  player_panel: "Panel",
  modder: "Mod",
  orchestrator: "Lead",
};

export function skillLabel(skill: string): string {
  if (skill in SKILL_LABELS) return SKILL_LABELS[skill as AgentSkill];
  return skill.replace(/_/g, " ");
}

export type ToolActivityVerb =
  | "fetch"
  | "search"
  | "read"
  | "write"
  | "run"
  | "snapshot"
  | "panel"
  | "skill"
  | "other";

export type ToolXpSpec = {
  xp: number;
  reason: string;
  celebrate?: boolean;
};

/** One catalog entry: LLM tool def + PlayOn surface metadata. */
export type ToolSurfaceEntry = ToolDefinition & {
  /** Primary agent skill that earns XP when this tool succeeds. */
  skill?: AgentSkill;
  /** Host-facing confirm phrase (required when requiresConfirm). */
  confirmAction?: string;
  activityVerb?: ToolActivityVerb;
  xp?: ToolXpSpec;
};

export type ToolSurfaceOverlay = {
  skill?: AgentSkill;
  confirmAction?: string;
  activityVerb?: ToolActivityVerb;
  xp?: ToolXpSpec;
};

let installed: Map<string, ToolSurfaceEntry> = new Map();

export function installToolSurface(entries: readonly ToolSurfaceEntry[]): void {
  installed = new Map(entries.map((e) => [e.name, e]));
}

export function getToolSurfaceEntry(name: string): ToolSurfaceEntry | undefined {
  return installed.get(name);
}

export function listToolSurface(): ToolSurfaceEntry[] {
  return [...installed.values()];
}

export function mergeToolSurface(
  defs: readonly ToolDefinition[],
  overlay: Record<string, ToolSurfaceOverlay>,
): ToolSurfaceEntry[] {
  return defs.map((def) => {
    const meta = overlay[def.name] ?? {};
    return {
      ...def,
      ...meta,
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      requiresConfirm: def.requiresConfirm,
    };
  });
}

export function toToolDefinition(entry: ToolSurfaceEntry): ToolDefinition {
  return {
    name: entry.name,
    description: entry.description,
    parameters: entry.parameters,
    requiresConfirm: entry.requiresConfirm,
  };
}

function humanizeToolName(toolName: string): string {
  const spaced = toolName.replace(/_/g, " ").trim();
  return spaced ? `run "${spaced}"` : "run a privileged action";
}

export function surfaceConfirmAction(toolName: string): string {
  return getToolSurfaceEntry(toolName)?.confirmAction ?? humanizeToolName(toolName);
}

export function surfaceActivityVerb(toolName: string): ToolActivityVerb {
  const explicit = getToolSurfaceEntry(toolName)?.activityVerb;
  if (explicit) return explicit;
  if (toolName.startsWith("skill_")) return "skill";
  if (toolName.startsWith("panel_")) return "panel";
  if (toolName.startsWith("snapshot_") || toolName.startsWith("backup_")) return "snapshot";
  if (toolName.startsWith("fs_")) {
    return /write|delete|rename|copy/.test(toolName) ? "write" : "read";
  }
  if (toolName === "archive_extract") return "write";
  if (toolName.startsWith("net_") || toolName === "fetch_url") return "fetch";
  if (toolName.startsWith("servers_")) return "run";
  return "other";
}

export function surfaceXp(toolName: string): ToolXpSpec {
  return getToolSurfaceEntry(toolName)?.xp ?? { xp: 5, reason: "tool_success" };
}

/** Primary skill that earns XP for a successful tool call. */
export function surfaceSkill(toolName: string): AgentSkill {
  return getToolSurfaceEntry(toolName)?.skill ?? "orchestrator";
}
