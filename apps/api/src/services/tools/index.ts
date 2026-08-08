import type { ToolEntry, ToolSurfaceEntry } from "@playon/agent-core";
import { contentToolModule } from "./content.js";
import { fsToolModule } from "./fs.js";
import { metaToolModule } from "./meta.js";
import { nodesToolModule } from "./nodes.js";
import { panelToolModule } from "./panel.js";
import { rconToolModule } from "./rcon.js";
import { serversToolModule } from "./servers.js";
import { skillsToolModule } from "./skills.js";
import { snapshotsToolModule } from "./snapshots.js";
import type { PlayOnToolEntry, ToolContext, ToolModule } from "./types.js";
import { watchersToolModule } from "./watchers.js";
import {
  resolveOptionalWorkspaceServerId,
  resolveWorkspaceServerId,
  type WorkspaceBinding,
} from "./workspace.js";

/**
 * Every tool domain. These modules are the only source of the tool catalog and
 * its surface metadata — there is no separate overlay table and no process-wide
 * install, so a tool that is not composed here does not exist.
 */
export const TOOL_MODULES: readonly ToolModule[] = [
  contentToolModule,
  fsToolModule,
  metaToolModule,
  nodesToolModule,
  panelToolModule,
  rconToolModule,
  serversToolModule,
  skillsToolModule,
  snapshotsToolModule,
  watchersToolModule,
];

/** Enforce the declared workspace scope, then hand the handler a resolved scope. */
function bindEntry(entry: PlayOnToolEntry, workspace: WorkspaceBinding): ToolEntry {
  return {
    def: entry.def,
    surface: entry.surface,
    workspacePolicy: entry.workspacePolicy,
    handler: async (args) => {
      if (entry.workspacePolicy === "none") return entry.handler(args, { serverId: undefined });
      const resolved =
        entry.workspacePolicy === "server_required"
          ? resolveWorkspaceServerId(args, workspace.serverId)
          : resolveOptionalWorkspaceServerId(args, workspace.serverId);
      if (!resolved.ok) return resolved.error;
      return entry.handler(args, { serverId: resolved.serverId });
    },
  };
}

export function composeToolEntries(
  ctx: ToolContext,
  modules: readonly ToolModule[] = TOOL_MODULES,
): ToolEntry[] {
  return modules.flatMap((module) => module(ctx)).map((entry) => bindEntry(entry, ctx.workspace));
}

/** Catalog projection for one composed registry: definition merged with its own metadata. */
export function toSurfaceEntry(entry: ToolEntry): ToolSurfaceEntry {
  return { ...entry.def, ...entry.surface };
}

export type { PlayOnToolEntry, ToolContext, ToolModule } from "./types.js";
