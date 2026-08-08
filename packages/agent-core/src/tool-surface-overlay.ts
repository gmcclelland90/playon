import { installToolSurface, type ToolSurfaceOverlay } from "./tool-surface.js";

/**
 * Surface metadata for tools that are not yet colocated as `ToolEntry` modules.
 * Migrated domains (fs, node/net meta) carry their own metadata on the entry and
 * are absent here; this table and its process-wide install disappear with the last domain.
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
  watchers_list: { skill: "monitor", activityVerb: "run" },
  watchers_get: { skill: "monitor", activityVerb: "run" },
  watchers_create: {
    skill: "monitor",
    confirmAction: "create a watcher automation",
    activityVerb: "run",
  },
  watchers_update: {
    skill: "monitor",
    confirmAction: "update a watcher automation",
    activityVerb: "run",
  },
  watchers_delete: {
    skill: "monitor",
    confirmAction: "delete a watcher automation",
    activityVerb: "run",
  },
  watchers_enable: { skill: "monitor", activityVerb: "run" },
  watchers_run_now: { skill: "monitor", activityVerb: "run" },
  watchers_runs_list: { skill: "monitor", activityVerb: "run" },
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
