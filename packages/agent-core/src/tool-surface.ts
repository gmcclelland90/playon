import type { ToolDefinition } from "./tools.js";

export type AgentPersona =
  | "orchestrator"
  | "installer"
  | "player_panel"
  | "modder"
  | "configurer"
  | "troubleshooter"
  | "monitor"
  | "backup";

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
  /** Non-orchestrator personas that may use this tool. Omit = orchestrator only. */
  personas?: readonly AgentPersona[];
  /** Host-facing confirm phrase (required when requiresConfirm). */
  confirmAction?: string;
  activityVerb?: ToolActivityVerb;
  xp?: ToolXpSpec;
};

export type ToolSurfaceOverlay = {
  personas?: readonly AgentPersona[];
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

/** Derive persona → tool allowlists from installed surface (orchestrator = all). */
export function derivePersonaAllowlist(
  entries: readonly ToolSurfaceEntry[] = listToolSurface(),
): Record<AgentPersona, readonly string[] | null> {
  const personas: AgentPersona[] = [
    "orchestrator",
    "installer",
    "player_panel",
    "modder",
    "configurer",
    "troubleshooter",
    "monitor",
    "backup",
  ];
  const out = {} as Record<AgentPersona, string[] | null>;
  out.orchestrator = null;
  for (const p of personas) {
    if (p === "orchestrator") continue;
    out[p] = [];
  }
  for (const entry of entries) {
    for (const p of entry.personas ?? []) {
      if (p === "orchestrator") continue;
      out[p]!.push(entry.name);
    }
  }
  return out as Record<AgentPersona, readonly string[] | null>;
}

export function surfaceToolsAllowedForPersona(persona: AgentPersona, toolName: string): boolean {
  if (persona === "orchestrator") return true;
  const entry = installed.get(toolName);
  if (!entry) return true;
  if (!entry.personas?.length) return false;
  return entry.personas.includes(persona);
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
