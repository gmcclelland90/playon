export type AgentPersona =
  | "orchestrator"
  | "installer"
  | "player_panel"
  | "modder"
  | "configurer"
  | "troubleshooter"
  | "monitor"
  | "backup";

/** Allowed tool names per persona (`null` = all registered tools). */
export const PERSONA_TOOL_ALLOWLIST: Record<AgentPersona, readonly string[] | null> = {
  orchestrator: null,
  installer: [
    "skill_list",
    "skill_draft_save",
    "skill_draft_list",
    "skill_promote",
    "skill_export",
    "skill_import",
    "skill_promote_server",
    "placement_suggest",
    "servers_create_from_skill",
    "servers_import_local",
    "servers_import_sftp",
    "servers_relocate",
    "servers_start",
    "servers_stop",
    "servers_restart",
    "servers_list",
    "servers_health_check",
    "snapshot_create",
    "snapshot_restore",
    "snapshot_list",
    "fs_list",
    "fs_read",
    "fs_write",
    "net_port_check",
    "net_suggest_bind",
    "fetch_url",
    "panel_publish",
    "panel_list",
  ],
  player_panel: ["panel_list", "panel_publish", "servers_list"],
  modder: [
    "servers_list",
    "fs_list",
    "fs_read",
    "fs_write",
    "fetch_url",
    "snapshot_create",
    "snapshot_list",
    "servers_restart",
  ],
  configurer: [
    "servers_list",
    "fs_list",
    "fs_read",
    "fs_write",
    "snapshot_create",
    "snapshot_list",
    "net_port_check",
    "net_suggest_bind",
    "servers_restart",
  ],
  troubleshooter: [
    "servers_list",
    "servers_start",
    "servers_stop",
    "servers_restart",
    "servers_health_check",
    "fs_list",
    "fs_read",
    "net_port_check",
    "snapshot_list",
    "snapshot_restore",
    "panel_list",
  ],
  monitor: [
    "servers_list",
    "servers_health_check",
    "panel_list",
    "panel_publish",
    "net_port_check",
    "snapshot_list",
  ],
  backup: [
    "servers_list",
    "snapshot_create",
    "snapshot_list",
    "snapshot_restore",
    "snapshot_enforce_retention",
    "backup_offnode",
    "backup_offnode_list",
    "backup_offnode_restore",
    "servers_stop",
    "servers_start",
  ],
};

export const PERSONA_SYSTEM_PROMPTS: Record<AgentPersona, string> = {
  orchestrator:
    "You are the PlayOn orchestrator. Route hosting requests, prefer skills and tools over guessing, and ask for confirmation on high-impact actions. Remember the full conversation — when the user answers with a short reply like A/B/C or yes/no, treat it as a response to your previous question.",
  installer:
    "You are the PlayOn installer agent. Create and update game servers using skills, snapshots, and scoped tools.",
  player_panel:
    "You are the PlayOn player panel agent. Keep join info and setup blocks accurate for players. Panel block types must be one of: server_status, join_info, client_setup, guide, vote, readiness, announcement, file_drop, discovery.",
  modder:
    "You are the PlayOn modder. Install and update mods/plugins inside a server data dir. Prefer snapshots before writes, never escape the server jail, and restart only when needed.",
  configurer:
    "You are the PlayOn configurer. Tune server configs (ports, difficulty, slots) with small reversible edits. Snapshot before risky writes and explain what changed.",
  troubleshooter:
    "You are the PlayOn troubleshooter. Diagnose failed starts, bad ports, and broken configs using inspect/list/read tools. Prefer restore or restart over destructive edits; escalate unknowns to the host.",
  monitor:
    "You are the PlayOn monitor. Watch server status and panel accuracy. Report health clearly; do not change world data. Publish status/join blocks when they drift.",
  backup:
    "You are the PlayOn backup agent. Create and restore snapshots, respect retention intent, and never delete worlds without host confirmation.",
};

export function toolsAllowedForPersona(persona: AgentPersona, toolName: string): boolean {
  const allow = PERSONA_TOOL_ALLOWLIST[persona];
  if (!allow) return true;
  return allow.includes(toolName);
}

/** Lightweight router for the admin chat entrypoint. */
export function pickPersona(userMessage: string): AgentPersona {
  const text = userMessage.toLowerCase();
  if (/\b(mod|plugin|datapack|modpack)\b/.test(text)) return "modder";
  if (/\b(config|configure|settings\.toml|server\.properties|difficulty|max.?players)\b/.test(text)) {
    return "configurer";
  }
  if (/\b(troubleshoot|broken|won't start|cant start|can't start|error|diagnose|fix)\b/.test(text)) {
    return "troubleshooter";
  }
  if (/\b(monitor|health check|is it up|watch)\b/.test(text)) return "monitor";
  if (/\b(backup|snapshot|restore)\b/.test(text)) return "backup";
  if (/\b(player panel|join info|readiness|vote|announcement|panel)\b/.test(text)) {
    return "player_panel";
  }
  if (/\b(install|spin up|create server|paper|minecraft|fixture|deploy)\b/.test(text)) {
    return "installer";
  }
  return "orchestrator";
}
