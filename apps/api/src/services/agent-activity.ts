export type AgentActivityVerb =
  | "fetch"
  | "search"
  | "read"
  | "write"
  | "run"
  | "snapshot"
  | "panel"
  | "skill"
  | "other";

const TOOL_VERBS: Record<string, AgentActivityVerb> = {
  fetch_url: "fetch",
  fs_read: "read",
  fs_list: "read",
  fs_write: "write",
  fs_delete: "write",
  fs_rename: "write",
  fs_copy: "write",
  archive_extract: "write",
  servers_start: "run",
  servers_stop: "run",
  servers_restart: "run",
  servers_create_from_skill: "run",
  servers_import_local: "run",
  servers_import_sftp: "run",
  servers_relocate: "run",
  servers_logs_tail: "read",
  snapshot_create: "snapshot",
  snapshot_restore: "snapshot",
  snapshot_list: "snapshot",
  snapshot_prune: "snapshot",
  backup_offnode: "snapshot",
  backup_offnode_list: "snapshot",
  backup_offnode_restore: "snapshot",
  panel_publish: "panel",
  panel_list: "panel",
  skill_list: "skill",
  skill_draft_save: "skill",
  skill_draft_list: "skill",
  skill_draft_set_query_connector: "skill",
  skill_promote: "skill",
  servers_query: "run",
  servers_query_test: "run",
  servers_health_check: "run",
  skill_export: "skill",
  skill_import: "skill",
  skill_promote_server: "skill",
  health_check: "run",
  placement_plan: "search",
  rcon_exec: "run",
  rcon_say: "run",
  steamcmd_app_update: "run",
  node_ping: "run",
  node_fs_list: "read",
};

export function verbForTool(toolName: string): AgentActivityVerb {
  if (TOOL_VERBS[toolName]) return TOOL_VERBS[toolName]!;
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
