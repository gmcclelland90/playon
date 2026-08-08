import type { ServerService } from "../servers.js";

/** Mutable chat↔server binding for the duration of an agent turn. */
export type WorkspaceBinding = { serverId: string | undefined };

/** Bound maintain chat cannot import/provision a sibling server identity. */
export function workspaceCreateForbidden(
  workspaceServerId: string | undefined,
  hint: string,
): Record<string, unknown> | null {
  if (!workspaceServerId) return null;
  return {
    error: "workspace_create_forbidden",
    workspaceServerId,
    hint,
  };
}

/**
 * First create in an unbound chat binds the workspace.
 * Later creates reinstall in place (same server id) instead of forking a sibling.
 */
export async function createOrReinstallFromSkill(
  servers: ServerService,
  workspace: WorkspaceBinding,
  args: { skillName: string; serverName?: string; nodeId?: string },
): Promise<{
  server: Awaited<ReturnType<ServerService["createFromSkill"]>>;
  mode: "created" | "reinstalled";
}> {
  if (workspace.serverId) {
    const server = await servers.reinstallFromSkill(workspace.serverId, args);
    return { server, mode: "reinstalled" };
  }
  const server = await servers.createFromSkill(args);
  workspace.serverId = server.id;
  return { server, mode: "created" };
}

function requestedServerId(args: Record<string, unknown>): string | undefined {
  const raw = args.serverId;
  return raw !== undefined && raw !== null && String(raw).trim() !== ""
    ? String(raw)
    : undefined;
}

export function resolveWorkspaceServerId(
  args: Record<string, unknown>,
  workspaceServerId: string | undefined,
): { ok: true; serverId: string } | { ok: false; error: Record<string, unknown> } {
  const requested = requestedServerId(args);
  if (workspaceServerId) {
    if (requested && requested !== workspaceServerId) {
      return {
        ok: false,
        error: {
          error: "workspace_server_mismatch",
          workspaceServerId,
          requestedServerId: requested,
        },
      };
    }
    return { ok: true, serverId: requested ?? workspaceServerId };
  }
  if (!requested) {
    return { ok: false, error: { error: "serverId_required" } };
  }
  return { ok: true, serverId: requested };
}

export function resolveOptionalWorkspaceServerId(
  args: Record<string, unknown>,
  workspaceServerId: string | undefined,
): { ok: true; serverId: string | undefined } | { ok: false; error: Record<string, unknown> } {
  const requested = requestedServerId(args);
  if (workspaceServerId) {
    if (requested && requested !== workspaceServerId) {
      return {
        ok: false,
        error: {
          error: "workspace_server_mismatch",
          workspaceServerId,
          requestedServerId: requested,
        },
      };
    }
    return { ok: true, serverId: requested ?? workspaceServerId };
  }
  return { ok: true, serverId: requested };
}
