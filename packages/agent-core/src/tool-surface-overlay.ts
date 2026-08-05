import { installToolSurface, type ToolSurfaceOverlay } from "./tool-surface.js";

/**
 * Canonical PlayOn tool surface metadata (skill / confirm / activity / XP).
 * Merged onto LLM toolDefs in the API; installed at agent-core load for projections.
 */
export const TOOL_SURFACE_OVERLAY = {
  archive_extract: {
    skill: "installer",
    confirmAction: "extract an archive into the server folder",
    activityVerb: "write",
  },
  backup_offnode: {
    skill: "backup",
    activityVerb: "snapshot",
    xp: { xp: 20, reason: "durable_backup" },
  },
  backup_offnode_list: { skill: "backup", activityVerb: "snapshot" },
  backup_offnode_restore: {
    skill: "backup",
    confirmAction: "restore this server from an off-site backup",
    activityVerb: "snapshot",
    xp: { xp: 45, reason: "recovery_offnode", celebrate: true },
  },
  fetch_url: {
    skill: "modder",
    confirmAction: "download a file into the server folder",
    activityVerb: "fetch",
  },
  fs_copy: {
    skill: "configurer",
    confirmAction: "copy a server file or folder",
    activityVerb: "write",
  },
  fs_delete: {
    skill: "configurer",
    confirmAction: "delete a server file or folder",
    activityVerb: "write",
  },
  fs_list: { skill: "troubleshooter", activityVerb: "read" },
  fs_read: { skill: "troubleshooter", activityVerb: "read" },
  fs_rename: {
    skill: "configurer",
    confirmAction: "rename or move a server path",
    activityVerb: "write",
  },
  fs_write: {
    skill: "configurer",
    confirmAction: "change a server file",
    activityVerb: "write",
  },
  net_port_check: { skill: "monitor", activityVerb: "fetch" },
  net_suggest_bind: { skill: "installer", activityVerb: "fetch" },
  node_fs_list: { skill: "installer", activityVerb: "read" },
  node_ping: { skill: "installer", activityVerb: "run" },
  panel_list: { skill: "player_panel", activityVerb: "panel" },
  panel_publish: {
    skill: "player_panel",
    activityVerb: "panel",
    xp: { xp: 10, reason: "player_panel" },
  },
  placement_suggest: { skill: "installer", activityVerb: "search" },
  nodes_add: { skill: "installer", activityVerb: "run" },
  nodes_remove: { skill: "installer", activityVerb: "run" },
  rcon_exec: { skill: "configurer", activityVerb: "run" },
  rcon_say: { skill: "configurer", activityVerb: "run" },
  servers_create_from_skill: {
    skill: "installer",
    activityVerb: "run",
    xp: { xp: 50, reason: "clean_install", celebrate: true },
  },
  servers_delete: {
    skill: "orchestrator",
    confirmAction: "permanently delete this server",
    activityVerb: "run",
  },
  servers_health_check: { skill: "monitor", activityVerb: "run" },
  servers_import_local: {
    skill: "installer",
    confirmAction: "import a server from a local folder",
    activityVerb: "run",
    xp: { xp: 55, reason: "clean_import", celebrate: true },
  },
  servers_import_sftp: {
    skill: "installer",
    confirmAction: "import a server over SFTP",
    activityVerb: "run",
    xp: { xp: 60, reason: "clean_import_sftp", celebrate: true },
  },
  servers_list: { skill: "orchestrator", activityVerb: "run" },
  servers_logs_tail: { skill: "troubleshooter", activityVerb: "read" },
  servers_query: { skill: "monitor", activityVerb: "run" },
  servers_query_test: { skill: "troubleshooter", activityVerb: "run" },
  servers_relocate: {
    skill: "installer",
    confirmAction: "move this server to another machine",
    activityVerb: "run",
    xp: { xp: 30, reason: "relocate" },
  },
  servers_restart: {
    skill: "troubleshooter",
    confirmAction: "restart this server",
    activityVerb: "run",
    xp: { xp: 12, reason: "server_restart" },
  },
  servers_start: {
    skill: "installer",
    activityVerb: "run",
    xp: { xp: 15, reason: "server_start" },
  },
  servers_stop: {
    skill: "installer",
    confirmAction: "stop this server",
    activityVerb: "run",
  },
  skill_draft_list: { skill: "installer", activityVerb: "skill" },
  skill_draft_save: { skill: "installer", activityVerb: "skill" },
  skill_draft_set_query_connector: { skill: "installer", activityVerb: "skill" },
  skill_export: { skill: "installer", activityVerb: "skill" },
  skill_import: {
    skill: "installer",
    confirmAction: "import a skill package",
    activityVerb: "skill",
  },
  skill_install_url: {
    skill: "installer",
    confirmAction: "install a skill from the public catalog",
    activityVerb: "skill",
    xp: { xp: 15, reason: "skill_catalog_install" },
  },
  skill_list: { skill: "installer", activityVerb: "skill" },
  skill_search: { skill: "installer", activityVerb: "skill" },
  skill_promote: {
    skill: "installer",
    confirmAction: "promote a draft skill so it can be installed",
    activityVerb: "skill",
    xp: { xp: 25, reason: "skill_promote" },
  },
  skill_promote_server: {
    skill: "installer",
    confirmAction: "add a server skill to the shared library",
    activityVerb: "skill",
  },
  skill_read: { skill: "installer", activityVerb: "skill" },
  snapshot_create: { skill: "backup", activityVerb: "snapshot" },
  snapshot_enforce_retention: { skill: "backup", activityVerb: "snapshot" },
  snapshot_list: { skill: "backup", activityVerb: "snapshot" },
  snapshot_restore: {
    skill: "backup",
    confirmAction: "restore this server from a snapshot",
    activityVerb: "snapshot",
    xp: { xp: 40, reason: "recovery", celebrate: true },
  },
  steamcmd_app_update: {
    skill: "installer",
    confirmAction: "download or update game files via Steam",
    activityVerb: "run",
  },
} as const satisfies Record<string, ToolSurfaceOverlay>;

/** Install meta-only entries so confirm/activity/XP/skill projections work at import time. */
installToolSurface(
  Object.entries(TOOL_SURFACE_OVERLAY).map(([name, meta]) => ({
    name,
    description: "",
    parameters: {},
    ...meta,
  })),
);
