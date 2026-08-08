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

/** PlayOn metadata colocated with a tool: how it reads to the host and what it earns. */
export type ToolSurfaceMeta = {
  /** Primary agent skill that earns XP when this tool succeeds. */
  skill?: AgentSkill;
  /** Host-facing confirm phrase (required when requiresConfirm). */
  confirmAction?: string;
  activityVerb?: ToolActivityVerb;
  xp?: ToolXpSpec;
};

/** One catalog entry: LLM tool def + PlayOn surface metadata. */
export type ToolSurfaceEntry = ToolDefinition & ToolSurfaceMeta;

/** Where a tool sits relative to the chat's bound server. Enforced before the handler runs. */
export type ToolWorkspacePolicy = "server_required" | "server_optional" | "none";

function humanizeToolName(toolName: string): string {
  const spaced = toolName.replace(/_/g, " ").trim();
  return spaced ? `run "${spaced}"` : "run a privileged action";
}

export function projectConfirmAction(
  entry: ToolSurfaceMeta | undefined,
  toolName: string,
): string {
  return entry?.confirmAction ?? humanizeToolName(toolName);
}

export function projectActivityVerb(
  entry: ToolSurfaceMeta | undefined,
  toolName: string,
): ToolActivityVerb {
  if (entry?.activityVerb) return entry.activityVerb;
  if (toolName.startsWith("skill_")) return "skill";
  if (toolName.startsWith("panel_")) return "panel";
  if (toolName.startsWith("snapshot_") || toolName.startsWith("backup_")) return "snapshot";
  if (toolName.startsWith("fs_")) {
    return /write|delete|rename|copy/.test(toolName) ? "write" : "read";
  }
  if (toolName.startsWith("net_")) return "fetch";
  if (toolName.startsWith("servers_")) return "run";
  return "other";
}

export function projectXp(entry: ToolSurfaceMeta | undefined): ToolXpSpec {
  return entry?.xp ?? { xp: 5, reason: "tool_success" };
}

/** Primary skill that earns XP for a successful tool call. */
export function projectSkill(entry: ToolSurfaceMeta | undefined): AgentSkill {
  return entry?.skill ?? "orchestrator";
}

/**
 * Read-only projection of one composed tool catalog. Every caller passes the
 * surface its registry returned: there is no ambient one to fall back to.
 */
export type ToolSurface = {
  get: (toolName: string) => ToolSurfaceEntry | undefined;
  list: () => ToolSurfaceEntry[];
  confirmAction: (toolName: string) => string;
  activityVerb: (toolName: string) => ToolActivityVerb;
  xp: (toolName: string) => ToolXpSpec;
  skill: (toolName: string) => AgentSkill;
};

export function createToolSurface(entries: readonly ToolSurfaceEntry[]): ToolSurface {
  const byName = new Map(entries.map((e) => [e.name, e]));
  return {
    get: (toolName) => byName.get(toolName),
    list: () => [...byName.values()],
    confirmAction: (toolName) => projectConfirmAction(byName.get(toolName), toolName),
    activityVerb: (toolName) => projectActivityVerb(byName.get(toolName), toolName),
    xp: (toolName) => projectXp(byName.get(toolName)),
    skill: (toolName) => projectSkill(byName.get(toolName)),
  };
}
