import { toLlmToolDefinition, type ToolDefinition } from "./tools.js";

/**
 * LLM-facing catalog stages. MCP and watcher scripts keep `full`.
 * In-app chat sends a job-sized subset so smaller models stay under TPM.
 */
export const TOOL_CATALOG_STAGES = ["install", "maintain", "full"] as const;
export type ToolCatalogStage = (typeof TOOL_CATALOG_STAGES)[number];

/**
 * Typical "spin up this game" chat: create → start → health → stop, plus
 * skill/placement/panel. Not rcon, WSL, snapshots, watcher-delete, or skill promote.
 */
export const INSTALL_TOOL_NAMES = [
  "skill_list",
  "skill_read",
  "skill_search",
  "skill_install_url",
  "placement_suggest",
  "net_port_check",
  "net_suggest_bind",
  "node_ping",
  "servers_create_from_skill",
  "servers_start",
  "servers_stop",
  "servers_health_check",
  "servers_list",
  "servers_logs_tail",
  "servers_query",
  "panel_publish",
  "panel_upsert",
  "panel_theme",
  "panel_list",
  "steamcmd_app_update",
] as const;

/** Bound maintain chat: jail/config/backup/watchers on the workspace server. */
export const MAINTAIN_EXTRA_TOOL_NAMES = [
  "fs_list",
  "fs_read",
  "fs_write",
  "fs_delete",
  "fs_rename",
  "fs_copy",
  "archive_extract",
  "fetch_url",
  "rcon_exec",
  "rcon_say",
  "servers_restart",
  "snapshot_create",
  "snapshot_restore",
  "snapshot_list",
  "snapshot_enforce_retention",
  "backup_offnode",
  "backup_offnode_list",
  "backup_offnode_restore",
  "watchers_list",
  "watchers_get",
  "watchers_create",
  "watchers_update",
  "watchers_delete",
  "watchers_enable",
  "watchers_run_now",
  "watchers_runs_list",
] as const;

/** Lifecycle tools the grok-4-5 usage-bar (create → start → health → stop) needs. */
export const USAGE_BAR_LIFECYCLE_TOOLS = [
  "servers_create_from_skill",
  "servers_start",
  "servers_health_check",
  "servers_stop",
] as const;

/** Domains that must stay off a typical unbound install chat. */
export const INSTALL_EXCLUDED_TOOLS = [
  "rcon_exec",
  "rcon_say",
  "wsl_status",
  "wsl_enable",
  "wsl_repair",
  "snapshot_create",
  "snapshot_restore",
  "snapshot_list",
  "watchers_delete",
  "skill_promote",
  "skill_promote_server",
  "nodes_add",
  "nodes_remove",
  "servers_delete",
] as const;

export const SESSION_CREATE_TOOLS = new Set([
  "servers_create_from_skill",
  "servers_import_local",
  "servers_import_sftp",
]);

const INSTALL_SET = new Set<string>(INSTALL_TOOL_NAMES);
const MAINTAIN_SET = new Set<string>([...INSTALL_TOOL_NAMES, ...MAINTAIN_EXTRA_TOOL_NAMES]);

export function toolNamesForCatalog(stage: ToolCatalogStage): ReadonlySet<string> | null {
  if (stage === "full") return null;
  if (stage === "install") return INSTALL_SET;
  return MAINTAIN_SET;
}

export function filterToolDefs<T extends { name: string }>(
  defs: readonly T[],
  stage: ToolCatalogStage,
): T[] {
  const allow = toolNamesForCatalog(stage);
  if (!allow) return [...defs];
  return defs.filter((d) => allow.has(d.name));
}

/** JSON bytes of the OpenAI-shaped tool payload (what burns TPM). */
export function serializedToolPayloadBytes(defs: readonly ToolDefinition[]): number {
  return JSON.stringify(defs.map(toLlmToolDefinition)).length;
}

export function catalogSystemPrompt(stage: ToolCatalogStage): string | undefined {
  if (stage === "install") {
    return [
      "This turn's tools are the install/lifecycle set: skills, placement, create/start/stop/health/list, and panel.",
      "rcon, snapshots, watchers, WSL, node enroll, and skill promote are not available this turn.",
      "Do not invent or call tools outside the offered list.",
    ].join(" ");
  }
  if (stage === "maintain") {
    return [
      "This turn's tools cover the bound server: lifecycle, files, rcon, snapshots, watchers, and panel.",
      "Do not target other serverIds. Host enroll (nodes_add) and skill promote are not available this turn.",
    ].join(" ");
  }
  return undefined;
}

export const SEQUENTIAL_TOOLS_PROMPT =
  "Call exactly one tool per response. The host loops until the task is done. Never emit multiple tool_calls in one completion.";

export function serverIdFromToolResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const rec = result as Record<string, unknown>;
  if (typeof rec.error === "string") return undefined;
  if (typeof rec.serverId === "string" && rec.serverId.trim()) return rec.serverId.trim();
  const nested = rec.server;
  if (nested && typeof nested === "object") {
    const id = (nested as { id?: unknown }).id;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return undefined;
}

export function requestedServerId(args: Record<string, unknown>): string | undefined {
  const raw = args.serverId;
  return raw !== undefined && raw !== null && String(raw).trim() !== ""
    ? String(raw).trim()
    : undefined;
}

/** True when servers_stop targets a server this session/turn created. */
export function isSessionCreatedStop(
  toolName: string,
  args: Record<string, unknown>,
  createdIds: ReadonlySet<string>,
  workspaceServerId?: string,
): boolean {
  if (toolName !== "servers_stop") return false;
  const target = requestedServerId(args) ?? workspaceServerId;
  return Boolean(target) && createdIds.has(target!);
}
