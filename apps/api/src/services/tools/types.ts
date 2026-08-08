import type {
  ToolDefinition,
  ToolSurfaceMeta,
  ToolWorkspacePolicy,
} from "@playon/agent-core";
import type { ControlPlane } from "../../control-plane.js";
import type { WorkspaceBinding } from "./workspace.js";

/** Everything a tool domain module needs to bind its handlers. */
export type ToolContext = {
  plane: ControlPlane;
  /** Binds on first create/import so mid-turn sibling creates cannot fork. */
  workspace: WorkspaceBinding;
  /** Global skills plus the bound server's own skill folder. */
  skillRoots: string[];
};

/** Server id already resolved against the workspace binding by the invoke path. */
export type ServerToolScope = { serverId: string };
export type OptionalServerToolScope = { serverId: string | undefined };

/**
 * A tool as its domain module declares it: definition, surface metadata,
 * workspace scope, and a handler that trusts the scope it is handed.
 */
export type PlayOnToolEntry = {
  def: ToolDefinition;
  surface: ToolSurfaceMeta;
  workspacePolicy: ToolWorkspacePolicy;
  handler: (args: Record<string, unknown>, scope: OptionalServerToolScope) => Promise<unknown>;
};

export type ToolModule = (ctx: ToolContext) => PlayOnToolEntry[];

/** Tool scoped to the chat's server; the invoke path rejects mismatches before the handler. */
export function serverTool(spec: {
  def: ToolDefinition;
  surface: ToolSurfaceMeta;
  handler: (args: Record<string, unknown>, scope: ServerToolScope) => Promise<unknown>;
}): PlayOnToolEntry {
  return {
    def: spec.def,
    surface: spec.surface,
    workspacePolicy: "server_required",
    handler: (args, scope) => spec.handler(args, scope as ServerToolScope),
  };
}

/** Tool that narrows to the bound server when there is one, but works unbound. */
export function optionalServerTool(spec: {
  def: ToolDefinition;
  surface: ToolSurfaceMeta;
  handler: (args: Record<string, unknown>, scope: OptionalServerToolScope) => Promise<unknown>;
}): PlayOnToolEntry {
  return {
    def: spec.def,
    surface: spec.surface,
    workspacePolicy: "server_optional",
    handler: spec.handler,
  };
}

/** Tool that never touches a server workspace (host probes, node jobs, catalog reads). */
export function globalTool(spec: {
  def: ToolDefinition;
  surface: ToolSurfaceMeta;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}): PlayOnToolEntry {
  return {
    def: spec.def,
    surface: spec.surface,
    workspacePolicy: "none",
    handler: (args) => spec.handler(args),
  };
}
