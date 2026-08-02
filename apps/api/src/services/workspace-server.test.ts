import { describe, expect, it } from "vitest";
import { resolveWorkspaceServerId, workspaceCreateForbidden } from "./tools.js";

describe("workspaceCreateForbidden", () => {
  it("allows create when unbound", () => {
    expect(workspaceCreateForbidden(undefined, "hint")).toBeNull();
  });

  it("blocks create inside a workspace", () => {
    const blocked = workspaceCreateForbidden("srv-a", "use install chat");
    expect(blocked).toMatchObject({
      error: "workspace_create_forbidden",
      workspaceServerId: "srv-a",
      hint: "use install chat",
    });
  });
});

describe("resolveWorkspaceServerId", () => {
  it("defaults to workspace when serverId omitted", () => {
    const resolved = resolveWorkspaceServerId({}, "srv-a");
    expect(resolved).toEqual({ ok: true, serverId: "srv-a" });
  });

  it("allows matching explicit serverId", () => {
    const resolved = resolveWorkspaceServerId({ serverId: "srv-a" }, "srv-a");
    expect(resolved).toEqual({ ok: true, serverId: "srv-a" });
  });

  it("rejects cross-server targeting", () => {
    const resolved = resolveWorkspaceServerId({ serverId: "srv-b" }, "srv-a");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error.error).toBe("workspace_server_mismatch");
    }
  });

  it("requires serverId outside a workspace", () => {
    const resolved = resolveWorkspaceServerId({}, undefined);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error.error).toBe("serverId_required");
    }
  });
});
