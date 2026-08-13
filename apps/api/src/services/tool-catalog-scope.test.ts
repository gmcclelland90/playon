import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  INSTALL_EXCLUDED_TOOLS,
  serializedToolPayloadBytes,
  USAGE_BAR_LIFECYCLE_TOOLS,
} from "@playon/agent-core";
import type { AppConfig } from "../config.js";
import { createControlPlane, type ControlPlane } from "../control-plane.js";
import { createDb } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { createPlayOnToolRegistry } from "./tools.js";

function testConfig(dataRoot: string): AppConfig {
  return {
    port: 0,
    advertiseHost: "127.0.0.1",
    dataRoot,
    dbPath: path.join(dataRoot, "playon.sqlite"),
    sessionSecret: "test-session-secret-at-least-32-chars!!",
    skillsRoots: [path.join(process.cwd(), "skills")],
    llmMode: "openai_compatible",
    runtimeMode: "docker",
  };
}

function testPlane(): ControlPlane {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "playon-catalog-"));
  applyBootstrap(path.join(dataRoot, "playon.sqlite"));
  const config = testConfig(dataRoot);
  const { db } = createDb(config.dbPath);
  return createControlPlane(db, config);
}

describe("in-app chat tool catalog scope", () => {
  it("sends a dramatically smaller payload than the full module catalog", () => {
    const plane = testPlane();
    const full = createPlayOnToolRegistry(plane, { catalog: "full" }).registry.getDefinitions();
    const install = createPlayOnToolRegistry(plane, { catalog: "install" }).registry.getDefinitions();

    const fullBytes = serializedToolPayloadBytes(full);
    const installBytes = serializedToolPayloadBytes(install);

    expect(install.length).toBeLessThan(full.length / 2);
    expect(installBytes).toBeLessThan(fullBytes * 0.45);
    expect(installBytes).toBeLessThan(fullBytes);

    const installNames = install.map((d) => d.name);
    for (const name of USAGE_BAR_LIFECYCLE_TOOLS) {
      expect(installNames, `${name} missing from install catalog`).toContain(name);
    }
    expect(installNames).toContain("placement_suggest");
    expect(installNames).toContain("panel_publish");
    expect(installNames).toContain("servers_list");

    for (const name of INSTALL_EXCLUDED_TOOLS) {
      expect(installNames, `${name} should not be on a spin-up turn`).not.toContain(name);
    }
  });

  it("rejects snapshot/stop/delete of an unrelated live server in a restricted session", async () => {
    const plane = testPlane();
    const { registry } = createPlayOnToolRegistry(plane, {
      catalog: "full",
      restrictTargets: true,
    });

    await expect(
      registry.invoke("snapshot_create", { serverId: "minecraft-small", label: "oops" }),
    ).resolves.toMatchObject({
      error: "session_target_forbidden",
      requestedServerId: "minecraft-small",
    });

    await expect(
      registry.invoke("servers_stop", { serverId: "minecraft-small" }),
    ).resolves.toMatchObject({
      error: "session_target_forbidden",
      requestedServerId: "minecraft-small",
    });

    await expect(
      registry.invoke("servers_delete", { serverId: "friend-live" }),
    ).resolves.toMatchObject({
      error: "session_target_forbidden",
      requestedServerId: "friend-live",
    });
  });

  it("still rejects cross-workspace snapshot_create when a chat is bound", async () => {
    const plane = testPlane();
    const { registry } = createPlayOnToolRegistry(plane, {
      workspaceServerId: "bound-server",
      restrictTargets: true,
      catalog: "maintain",
    });

    await expect(
      registry.invoke("snapshot_create", { serverId: "minecraft-small" }),
    ).resolves.toMatchObject({
      error: "workspace_server_mismatch",
      workspaceServerId: "bound-server",
      requestedServerId: "minecraft-small",
    });

    await expect(
      registry.invoke("servers_stop", { serverId: "minecraft-small" }),
    ).resolves.toMatchObject({ error: "workspace_server_mismatch" });
  });

  it("does not leak live inventory from servers_list in an unbound restricted chat", async () => {
    const plane = testPlane();
    const { registry } = createPlayOnToolRegistry(plane, {
      catalog: "install",
      restrictTargets: true,
    });
    await expect(registry.invoke("servers_list", {})).resolves.toEqual([]);
  });

  it("keeps the full catalog for MCP-style unbound registries", () => {
    const plane = testPlane();
    const { registry } = createPlayOnToolRegistry(plane, {});
    const names = registry.getDefinitions().map((d) => d.name);
    expect(names).toContain("rcon_exec");
    expect(names).toContain("watchers_delete");
    expect(names).toContain("snapshot_create");
    expect(names).toContain("wsl_enable");
    expect(names.length).toBeGreaterThan(50);
  });
});
