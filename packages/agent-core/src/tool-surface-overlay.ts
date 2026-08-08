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
  fetch_url: {
    skill: "modder",
    confirmAction: "download a file into the server folder",
    activityVerb: "fetch",
  },
  placement_suggest: { skill: "installer", activityVerb: "search" },
  nodes_add: { skill: "installer", activityVerb: "run" },
  nodes_remove: { skill: "installer", activityVerb: "run" },
  rcon_exec: { skill: "configurer", activityVerb: "run" },
  rcon_say: { skill: "configurer", activityVerb: "run" },
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
