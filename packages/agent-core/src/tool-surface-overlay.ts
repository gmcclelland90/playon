import { installToolSurface, type ToolSurfaceOverlay } from "./tool-surface.js";

/**
 * Canonical PlayOn tool surface metadata (personas / confirm / activity / XP).
 * Merged onto LLM toolDefs in the API; installed at agent-core load for projections.
 */
export const TOOL_SURFACE_OVERLAY = {
  archive_extract: {
    personas: ["installer", "modder"],
    confirmAction: "extract an archive into the server folder",
    activityVerb: "write",
  },
  backup_offnode: {
    personas: ["backup"],
    activityVerb: "snapshot",
    xp: { xp: 20, reason: "durable_backup" },
  },
  backup_offnode_list: { personas: ["backup"], activityVerb: "snapshot" },
  backup_offnode_restore: {
    personas: ["backup"],
    confirmAction: "restore this server from an off-site backup",
    activityVerb: "snapshot",
    xp: { xp: 45, reason: "recovery_offnode", celebrate: true },
  },
  fetch_url: {
    personas: ["installer", "modder"],
    confirmAction: "download a file into the server folder",
    activityVerb: "fetch",
  },
  fs_copy: {
    personas: ["installer", "modder", "configurer"],
    confirmAction: "copy a server file or folder",
    activityVerb: "write",
  },
  fs_delete: {
    personas: ["installer", "modder", "configurer"],
    confirmAction: "delete a server file or folder",
    activityVerb: "write",
  },
  fs_list: {
    personas: ["installer", "modder", "configurer", "troubleshooter"],
    activityVerb: "read",
  },
  fs_read: {
    personas: ["installer", "modder", "configurer", "troubleshooter"],
    activityVerb: "read",
  },
  fs_rename: {
    personas: ["installer", "modder", "configurer"],
    confirmAction: "rename or move a server path",
    activityVerb: "write",
  },
  fs_write: {
    personas: ["installer", "modder", "configurer"],
    confirmAction: "change a server file",
    activityVerb: "write",
  },
  net_port_check: {
    personas: ["installer", "configurer", "troubleshooter", "monitor"],
    activityVerb: "fetch",
  },
  net_suggest_bind: { personas: ["installer", "configurer"], activityVerb: "fetch" },
  node_fs_list: { personas: ["installer"], activityVerb: "read" },
  node_ping: { personas: ["installer"], activityVerb: "run" },
  panel_list: {
    personas: ["installer", "player_panel", "troubleshooter", "monitor"],
    activityVerb: "panel",
  },
  panel_publish: {
    personas: ["installer", "player_panel", "monitor"],
    activityVerb: "panel",
    xp: { xp: 10, reason: "player_panel" },
  },
  placement_suggest: { personas: ["installer"], activityVerb: "search" },
  rcon_exec: {
    personas: ["modder", "configurer", "troubleshooter", "monitor"],
    activityVerb: "run",
  },
  rcon_say: {
    personas: ["configurer", "troubleshooter", "monitor"],
    activityVerb: "run",
  },
  servers_create_from_skill: {
    personas: ["installer"],
    activityVerb: "run",
    xp: { xp: 50, reason: "clean_install", celebrate: true },
  },
  servers_delete: {
    confirmAction: "permanently delete this server",
    activityVerb: "run",
  },
  servers_health_check: {
    personas: ["installer", "modder", "troubleshooter", "monitor"],
    activityVerb: "run",
  },
  servers_import_local: {
    personas: ["installer"],
    confirmAction: "import a server from a local folder",
    activityVerb: "run",
    xp: { xp: 55, reason: "clean_import", celebrate: true },
  },
  servers_import_sftp: {
    personas: ["installer"],
    confirmAction: "import a server over SFTP",
    activityVerb: "run",
    xp: { xp: 60, reason: "clean_import_sftp", celebrate: true },
  },
  servers_list: {
    personas: [
      "installer",
      "player_panel",
      "modder",
      "configurer",
      "troubleshooter",
      "monitor",
      "backup",
    ],
    activityVerb: "run",
  },
  servers_logs_tail: {
    personas: ["installer", "modder", "troubleshooter"],
    activityVerb: "read",
  },
  servers_query: {
    personas: ["installer", "modder", "troubleshooter", "monitor"],
    activityVerb: "run",
  },
  servers_query_test: { personas: ["installer", "troubleshooter"], activityVerb: "run" },
  servers_relocate: {
    personas: ["installer", "backup"],
    confirmAction: "move this server to another machine",
    activityVerb: "run",
    xp: { xp: 30, reason: "relocate" },
  },
  servers_restart: {
    personas: ["installer", "modder", "configurer", "troubleshooter"],
    confirmAction: "restart this server",
    activityVerb: "run",
    xp: { xp: 12, reason: "server_restart" },
  },
  servers_start: {
    personas: ["installer", "troubleshooter", "backup"],
    activityVerb: "run",
    xp: { xp: 15, reason: "server_start" },
  },
  servers_stop: {
    personas: ["installer", "troubleshooter", "backup"],
    confirmAction: "stop this server",
    activityVerb: "run",
  },
  skill_draft_list: { personas: ["installer"], activityVerb: "skill" },
  skill_draft_save: { personas: ["installer"], activityVerb: "skill" },
  skill_draft_set_query_connector: { personas: ["installer"], activityVerb: "skill" },
  skill_export: { personas: ["installer"], activityVerb: "skill" },
  skill_import: {
    personas: ["installer"],
    confirmAction: "import a skill package",
    activityVerb: "skill",
  },
  skill_install_url: {
    personas: ["installer"],
    confirmAction: "install a skill from the public catalog",
    activityVerb: "skill",
    xp: { xp: 15, reason: "skill_catalog_install" },
  },
  skill_list: { personas: ["installer"], activityVerb: "skill" },
  skill_search: { personas: ["installer"], activityVerb: "skill" },
  skill_promote: {
    personas: ["installer"],
    confirmAction: "promote a draft skill so it can be installed",
    activityVerb: "skill",
    xp: { xp: 25, reason: "skill_promote" },
  },
  skill_promote_server: {
    personas: ["installer"],
    confirmAction: "add a server skill to the shared library",
    activityVerb: "skill",
  },
  skill_read: { personas: ["installer", "modder"], activityVerb: "skill" },
  snapshot_create: {
    personas: ["installer", "modder", "configurer", "backup"],
    activityVerb: "snapshot",
  },
  snapshot_enforce_retention: { personas: ["backup"], activityVerb: "snapshot" },
  snapshot_list: {
    personas: ["installer", "modder", "troubleshooter", "monitor", "backup"],
    activityVerb: "snapshot",
  },
  snapshot_restore: {
    personas: ["installer", "modder", "troubleshooter", "backup"],
    confirmAction: "restore this server from a snapshot",
    activityVerb: "snapshot",
    xp: { xp: 40, reason: "recovery", celebrate: true },
  },
  steamcmd_app_update: {
    personas: ["installer", "modder"],
    confirmAction: "download or update game files via Steam",
    activityVerb: "run",
  },
} as const satisfies Record<string, ToolSurfaceOverlay>;

/** Install meta-only entries so confirm/activity/XP/persona projections work at import time. */
installToolSurface(
  Object.entries(TOOL_SURFACE_OVERLAY).map(([name, meta]) => ({
    name,
    description: "",
    parameters: {},
    ...meta,
  })),
);
