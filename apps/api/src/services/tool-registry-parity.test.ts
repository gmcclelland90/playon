import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getToolSurfaceEntry,
  listToolSurface,
  OpenAICompatibleLlmClient,
} from "@playon/agent-core";
import type { AppConfig } from "../config.js";
import { createControlPlane, type ControlPlane } from "../control-plane.js";
import { createDb } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { createOrchestrator, createPlayOnToolRegistry } from "./tools.js";

/** Domains already colocated as ToolEntry modules (metadata lives on the entry). */
const MIGRATED_TOOLS = [
  "fs_list",
  "fs_read",
  "fs_write",
  "fs_delete",
  "fs_rename",
  "fs_copy",
  "node_ping",
  "node_fs_list",
  "net_port_check",
  "net_suggest_bind",
  "servers_create_from_skill",
  "servers_start",
  "servers_stop",
  "servers_restart",
  "servers_list",
  "servers_health_check",
  "servers_relocate",
  "servers_import_local",
  "servers_import_sftp",
  "servers_delete",
  "servers_logs_tail",
  "servers_query",
  "servers_query_test",
  "skill_list",
  "skill_read",
  "skill_draft_save",
  "skill_draft_list",
  "skill_draft_set_query_connector",
  "skill_promote",
  "skill_promote_server",
  "skill_export",
  "skill_import",
  "skill_search",
  "skill_install_url",
  "panel_publish",
  "panel_list",
  "watchers_list",
  "watchers_get",
  "watchers_create",
  "watchers_update",
  "watchers_delete",
  "watchers_enable",
  "watchers_run_now",
  "watchers_runs_list",
];

/** Server-scoped entries the invoke path must resolve before the handler sees them. */
const SERVER_SCOPED_TOOLS = [
  "servers_start",
  "servers_stop",
  "servers_restart",
  "servers_health_check",
  "servers_relocate",
  "servers_delete",
  "servers_logs_tail",
  "servers_query",
  "skill_promote_server",
  "watchers_create",
];

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
  const dataRoot = mkdtempSync(path.join(tmpdir(), "playon-parity-"));
  applyBootstrap(path.join(dataRoot, "playon.sqlite"));
  const config = testConfig(dataRoot);
  const { db } = createDb(config.dbPath);
  return createControlPlane(db, config);
}

describe("tool registry parity (Venice/Ollama/MCP)", () => {
  it("orchestrator and MCP registry expose identical tool fingerprints", () => {
    const plane = testPlane();
    const { registry } = createPlayOnToolRegistry(plane, {});
    const llm = new OpenAICompatibleLlmClient(
      "http://127.0.0.1:9/v1",
      "unused",
      "test",
      "openai_compatible",
    );
    const orch = createOrchestrator(plane, llm, {});

    const fromRegistry = registry.parityFingerprint();
    const fromOrch = orch
      .getToolDefinitions()
      .map((d) => ({ name: d.name, requiresConfirm: Boolean(d.requiresConfirm) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Moving a domain onto ToolEntry must not add, drop, or re-gate a tool.
    expect(fromRegistry).toHaveLength(59);
    expect(fromOrch).toEqual(fromRegistry);
  });

  it("returns a surface whose keys are exactly the registry tool names", () => {
    const { registry, surface } = createPlayOnToolRegistry(testPlane(), {});
    const registryNames = registry
      .entries()
      .map((e) => e.def.name)
      .sort();
    const surfaceNames = surface
      .list()
      .map((e) => e.name)
      .sort();

    expect(surfaceNames).toEqual(registryNames);
    expect(new Set(registryNames).size).toBe(registryNames.length);
  });

  it("migrated entries carry complete metadata on the entry itself", () => {
    const { registry } = createPlayOnToolRegistry(testPlane(), {});
    const byName = new Map(registry.entries().map((e) => [e.def.name, e]));

    for (const name of MIGRATED_TOOLS) {
      const entry = byName.get(name);
      expect(entry, `missing migrated tool: ${name}`).toBeDefined();
      expect(entry!.def.name).toBe(name);
      expect(entry!.def.description.length).toBeGreaterThan(0);
      expect(entry!.workspacePolicy).toBeDefined();
      expect(entry!.surface?.skill, `${name} has no skill`).toBeDefined();
      expect(entry!.surface?.activityVerb, `${name} has no activityVerb`).toBeDefined();
      if (entry!.def.requiresConfirm) {
        expect(entry!.surface?.confirmAction, `${name} confirms without copy`).toBeTruthy();
      }
    }
  });

  it("does not install the composed surface into the process global", () => {
    const before = listToolSurface().length;
    const { surface } = createPlayOnToolRegistry(testPlane(), {});

    expect(listToolSurface().length).toBe(before);
    for (const name of MIGRATED_TOOLS) {
      expect(getToolSurfaceEntry(name), `${name} leaked to the global surface`).toBeUndefined();
      expect(surface.get(name)).toBeDefined();
    }
    expect(surface.skill("fs_write")).toBe("configurer");
    expect(surface.confirmAction("fs_write")).toBe("change a server file");
    expect(surface.activityVerb("node_ping")).toBe("run");
    expect(surface.confirmAction("servers_stop")).toBe("stop this server");
    expect(surface.xp("servers_create_from_skill")).toEqual({
      xp: 50,
      reason: "clean_install",
      celebrate: true,
    });
    expect(surface.skill("servers_logs_tail")).toBe("troubleshooter");
    expect(surface.activityVerb("servers_logs_tail")).toBe("read");
    expect(surface.skill("panel_publish")).toBe("player_panel");
    expect(surface.xp("panel_publish")).toEqual({ xp: 10, reason: "player_panel" });
    expect(surface.activityVerb("skill_search")).toBe("skill");
    expect(surface.confirmAction("skill_install_url")).toBe(
      "install a skill from the public catalog",
    );
    expect(surface.skill("watchers_run_now")).toBe("monitor");
    expect(surface.confirmAction("watchers_delete")).toBe("delete a watcher automation");
  });

  it("declares server scope for lifecycle tools that act on one server", () => {
    const { registry } = createPlayOnToolRegistry(testPlane(), {});
    const byName = new Map(registry.entries().map((e) => [e.def.name, e]));

    for (const name of SERVER_SCOPED_TOOLS) {
      expect(byName.get(name)?.workspacePolicy, `${name} is not server-scoped`).toBe(
        "server_required",
      );
    }
    expect(byName.get("servers_list")?.workspacePolicy).toBe("none");
    expect(byName.get("servers_query_test")?.workspacePolicy).toBe("none");
    expect(byName.get("skill_list")?.workspacePolicy).toBe("none");
    // Panel tools narrow to the bound server but still answer in an unbound chat.
    expect(byName.get("panel_publish")?.workspacePolicy).toBe("server_optional");
    expect(byName.get("panel_list")?.workspacePolicy).toBe("server_optional");
    expect(byName.get("watchers_list")?.workspacePolicy).toBe("server_optional");
    // Watcher-id tools enforce the binding against the watcher's own server instead.
    for (const name of [
      "watchers_get",
      "watchers_update",
      "watchers_delete",
      "watchers_enable",
      "watchers_run_now",
      "watchers_runs_list",
    ]) {
      expect(byName.get(name)?.workspacePolicy, `${name} should not resolve args.serverId`).toBe(
        "none",
      );
    }
  });

  it("enforces workspace policy before the handler runs", async () => {
    const { registry } = createPlayOnToolRegistry(testPlane(), {
      workspaceServerId: "bound-server",
    });

    await expect(
      registry.invoke("fs_list", { serverId: "other-server" }),
    ).resolves.toMatchObject({
      error: "workspace_server_mismatch",
      workspaceServerId: "bound-server",
      requestedServerId: "other-server",
    });

    await expect(
      registry.invoke("servers_logs_tail", { serverId: "other-server" }),
    ).resolves.toMatchObject({
      error: "workspace_server_mismatch",
      workspaceServerId: "bound-server",
      requestedServerId: "other-server",
    });

    // Watcher-id tools reach their handler in a bound chat and check ownership there.
    await expect(registry.invoke("watchers_get", { watcherId: "nope" })).resolves.toEqual({
      error: "not_found",
    });

    const unbound = createPlayOnToolRegistry(testPlane(), {}).registry;
    await expect(unbound.invoke("fs_list", {})).resolves.toEqual({
      error: "serverId_required",
    });
    await expect(unbound.invoke("servers_logs_tail", {})).resolves.toEqual({
      error: "serverId_required",
    });
  });
});
