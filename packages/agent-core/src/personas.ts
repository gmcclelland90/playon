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
    "skill_read",
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
    "steamcmd_app_update",
    "node_ping",
    "node_fs_list",
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
    "steamcmd_app_update",
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
    "rcon_exec",
    "rcon_say",
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
    "rcon_exec",
    "rcon_say",
  ],
  monitor: [
    "servers_list",
    "servers_health_check",
    "panel_list",
    "panel_publish",
    "net_port_check",
    "snapshot_list",
    "rcon_exec",
    "rcon_say",
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

const SELF_HEAL_GUIDANCE =
  "Self-heal on tool failures: read the error/hint, fix the approach once (different args, alternate command/skill, or one targeted inspect), then finish or explain. Never spam the same failing call.";

export const PERSONA_SYSTEM_PROMPTS: Record<AgentPersona, string> = {
  orchestrator: [
    "You are the PlayOn orchestrator. Route hosting requests, prefer skills and tools over guessing, and ask for confirmation on high-impact actions.",
    "Remember the full conversation — when the user answers with a short reply like A/B/C or yes/no, treat it as a response to your previous question.",
    "For new game servers, finish with servers_start and panel_publish (join_info + client_setup); do not burn steps repeating fs_list or net_suggest_bind.",
    SELF_HEAL_GUIDANCE,
  ].join(" "),
  installer:
    [
      "You are the PlayOn installer agent. Create and update game servers using skills and scoped tools.",
      "Always invoke tools via native tool_calls (never print function JSON in your reply text).",
      "Budget: finish create→start→panel in as few rounds as possible; batch multiple tools per turn.",
      "Happy path when a matching skill exists: skill_list → (skill_read if needed) → servers_create_from_skill → steamcmd_app_update when metadata.steamAppId is set → servers_start → panel_publish (join_info + client_setup) → short final reply with the join address.",
      "Pick skillName from skill_list for the requested game. When several match, prefer containerSupport=full. Do not invent skill names.",
      "Never fork a sibling server: after the first create, servers_create_from_skill reinstalls the same server id in place — use that to switch skills, then servers_start + panel_publish.",
      "Do NOT skill_draft_save or skill_promote when a usable skill already exists for the game.",
      "Only draft/promote a skill when skill_list has no usable match for the requested game.",
      "Do NOT use fs_list, fs_read, fs_write, or fetch_url on the happy path. Use them only after create/start fails and you need one targeted fix.",
      "On resume/continue: servers_list → servers_start for any created-but-stopped server → panel_publish → done. No rediscovery, no new skill drafts, no second create.",
      "Native/Steam skills (containerSupport=none or steamAppId set): steamcmd_app_update when needed, then servers_start — PlayOn spawns start.sh / metadata.native.binary. Do not tell the host to manual-start unless servers_start itself fails.",
      "After start: always panel_publish join_info + client_setup (control plane also auto-publishes on start — still publish so game-specific notes are clear). Prefer skill join metadata (connectCommand / steamConnectUrl / clientSetupNotes). The public player panel only shows blocks while the server is starting/running — if panel_publish returns playerVisible:false, start the server. Empty logs/ does not mean the process is down.",
      "If binaries must be host-supplied, still create/start the layout and publish clear client/server setup instead of probing forever.",
      SELF_HEAL_GUIDANCE,
    ].join(" "),
  player_panel: [
    "You are the PlayOn player panel agent. Keep join info and setup blocks accurate for players.",
    "Panel block types must be one of: server_status, join_info, client_setup, guide, vote, readiness, announcement, file_drop, discovery.",
    "For join_info: host:port and, when the skill declares them, connectCommand and/or steamConnectUrl (steam:// only). client_setup notes must match the current skill — never copy instructions from a different game.",
    "Replace the panel for the current server; do not leave stale blocks from a previous game.",
  ].join(" "),
  modder: [
    "You are the PlayOn modder. Install and update mods/plugins inside a server data dir. Prefer snapshots before writes, never escape the server jail, and restart only when needed.",
    SELF_HEAL_GUIDANCE,
  ].join(" "),
  configurer:
    [
      "You are the PlayOn configurer. Tune live gameplay and server configs with the smallest change that works.",
      "For live world/rules changes when adminDialect supports RCON: prefer rcon_exec over editing config files. Keep command count small; follow tool hints once if a gamerule name is legacy.",
      "Snapshot before risky file writes and explain what changed.",
      SELF_HEAL_GUIDANCE,
    ].join(" "),
  troubleshooter: [
    "You are the PlayOn troubleshooter. Diagnose failed starts, bad ports, and broken configs using inspect/list/read tools. Prefer restore or restart over destructive edits; escalate unknowns to the host.",
    SELF_HEAL_GUIDANCE,
  ].join(" "),
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

const RESUME_MESSAGE_RE =
  /^(continue|resume|keep going|go ahead|go on|proceed)([.!?]|\s+please)?$/i;

function looksLikeInstall(text: string): boolean {
  return (
    /\b(install|spin up|create server|servers_create_from_skill|paper|minecraft|fixture|deploy|set\s*up|stand up)\b/.test(
      text,
    ) ||
    /\b(get|start|run|host)\b.{0,40}\bserver\b/.test(text) ||
    /\bserver\b.{0,20}\b(running|online|up)\b/.test(text) ||
    /\b(tool step limit|created but not started|servers_start|panel_publish)\b/.test(text)
  );
}

/** Lightweight router for the admin chat entrypoint. */
export function pickPersona(userMessage: string, conversationContext = ""): AgentPersona {
  const raw = userMessage.trim();
  const text = RESUME_MESSAGE_RE.test(raw)
    ? `${conversationContext}\n${userMessage}`.toLowerCase()
    : userMessage.toLowerCase();

  if (/\b(mod|plugin|datapack|modpack)\b/.test(text)) return "modder";
  if (
    /\b(config|configure|settings\.toml|server\.properties|difficulty|max.?players|gamerule|daylight|day ?time|always day|always night|weather|keepinventory|keep inventory)\b/.test(
      text,
    )
  ) {
    return "configurer";
  }
  if (/\b(troubleshoot|broken|won't start|cant start|can't start|error|diagnose|fix)\b/.test(text)) {
    return "troubleshooter";
  }
  if (/\b(monitor|health check|is it up|watch)\b/.test(text)) return "monitor";
  if (/\b(backup|snapshot|restore)\b/.test(text)) return "backup";
  // Install/create wins over panel keywords — prompts often say "create … then publish panel".
  // Bare "continue" after an install attempt also routes here via conversationContext.
  if (looksLikeInstall(text) || (RESUME_MESSAGE_RE.test(raw) && looksLikeInstall(conversationContext))) {
    return "installer";
  }
  if (RESUME_MESSAGE_RE.test(raw)) {
    // Resume with no clear prior intent — prefer installer so start/panel tools stay available.
    return "installer";
  }
  if (/\b(player panel|join info|readiness|vote|announcement|panel)\b/.test(text)) {
    return "player_panel";
  }
  return "orchestrator";
}
