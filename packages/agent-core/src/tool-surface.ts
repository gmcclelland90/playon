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

/** @deprecated Name kept while unmigrated tools still read metadata from a separate table. */
export type ToolSurfaceOverlay = ToolSurfaceMeta;

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
  if (toolName === "archive_extract") return "write";
  if (toolName.startsWith("net_") || toolName === "fetch_url") return "fetch";
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
 * Read-only projection of one composed tool catalog.
 * Callers pass this explicitly — projections must not depend on install order.
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

/**
 * Legacy process-wide surface, populated by the overlay table at import time.
 * Only tools not yet migrated to `ToolEntry` read through it; new call sites take a
 * `ToolSurface` argument instead. Removed with the overlay in the final W1b slice.
 */
let ambient: ToolSurface = createToolSurface([]);

export function installToolSurface(entries: readonly ToolSurfaceEntry[]): void {
  ambient = createToolSurface(entries);
}

export function getToolSurfaceEntry(name: string): ToolSurfaceEntry | undefined {
  return ambient.get(name);
}

export function listToolSurface(): ToolSurfaceEntry[] {
  return ambient.list();
}

export function surfaceConfirmAction(toolName: string): string {
  return ambient.confirmAction(toolName);
}

export function surfaceActivityVerb(toolName: string): ToolActivityVerb {
  return ambient.activityVerb(toolName);
}

export function surfaceXp(toolName: string): ToolXpSpec {
  return ambient.xp(toolName);
}

export function surfaceSkill(toolName: string): AgentSkill {
  return ambient.skill(toolName);
}
