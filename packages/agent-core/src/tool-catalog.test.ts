import { describe, expect, it } from "vitest";
import {
  catalogSystemPrompt,
  filterToolDefs,
  INSTALL_EXCLUDED_TOOLS,
  INSTALL_TOOL_NAMES,
  isSessionCreatedStop,
  serializedToolPayloadBytes,
  serverIdFromToolResult,
  toolNamesForCatalog,
  USAGE_BAR_LIFECYCLE_TOOLS,
} from "./tool-catalog.js";
import type { ToolDefinition } from "./tools.js";

function def(name: string, extra = ""): ToolDefinition {
  return {
    name,
    description: `${name} ${extra}`.repeat(4),
    parameters: {
      type: "object",
      properties: { serverId: { type: "string" }, extra: { type: "string" } },
    },
  };
}

describe("tool catalog stages", () => {
  it("keeps install→start→health→stop on the install surface", () => {
    const install = toolNamesForCatalog("install")!;
    for (const name of USAGE_BAR_LIFECYCLE_TOOLS) {
      expect(install.has(name), name).toBe(true);
    }
    expect(install.has("placement_suggest")).toBe(true);
    expect(install.has("panel_publish")).toBe(true);
    expect(install.has("servers_list")).toBe(true);
  });

  it("keeps rcon/wsl/snapshot/watcher-delete/skill_promote off install", () => {
    const install = toolNamesForCatalog("install")!;
    for (const name of INSTALL_EXCLUDED_TOOLS) {
      expect(install.has(name), name).toBe(false);
    }
  });

  it("does not filter the full catalog", () => {
    const defs = [def("rcon_exec"), def("servers_stop"), def("wsl_enable")];
    expect(filterToolDefs(defs, "full").map((d) => d.name)).toEqual([
      "rcon_exec",
      "servers_stop",
      "wsl_enable",
    ]);
  });

  it("serializes a typical chat payload much smaller than all modules", () => {
    const extraFull = [
      ...INSTALL_EXCLUDED_TOOLS,
      "fs_write",
      "fs_read",
      "fs_list",
      "fs_delete",
      "fs_rename",
      "fs_copy",
      "watchers_create",
      "watchers_list",
      "watchers_get",
      "watchers_update",
      "watchers_enable",
      "watchers_run_now",
      "watchers_runs_list",
      "skill_draft_save",
      "skill_draft_list",
      "skill_export",
      "skill_import",
      "servers_import_sftp",
      "servers_import_local",
      "servers_relocate",
      "servers_restart",
      "backup_offnode",
      "backup_offnode_list",
      "archive_extract",
      "fetch_url",
      "node_fs_list",
    ];
    const allNames = [...new Set([...INSTALL_TOOL_NAMES, ...extraFull])];
    const all = allNames.map((n) => def(n, "full-catalog-padding"));
    const install = filterToolDefs(all, "install");
    const allBytes = serializedToolPayloadBytes(all);
    const installBytes = serializedToolPayloadBytes(install);
    expect(all.length).toBeGreaterThan(40);
    expect(install.length).toBeLessThan(all.length / 2);
    expect(installBytes).toBeLessThan(allBytes * 0.5);
    for (const name of USAGE_BAR_LIFECYCLE_TOOLS) {
      expect(install.map((d) => d.name)).toContain(name);
    }
  });

  it("describes the install stage to the model", () => {
    expect(catalogSystemPrompt("install")).toMatch(/install\/lifecycle/);
    expect(catalogSystemPrompt("full")).toBeUndefined();
  });
});

describe("session-created stop", () => {
  it("extracts serverId from create results", () => {
    expect(serverIdFromToolResult({ serverId: "srv-new", mode: "created" })).toBe("srv-new");
    expect(serverIdFromToolResult({ error: "nope", serverId: "x" })).toBeUndefined();
    expect(serverIdFromToolResult({ server: { id: "nested" } })).toBe("nested");
  });

  it("allows stop only for session-created ids", () => {
    const created = new Set(["srv-new"]);
    expect(isSessionCreatedStop("servers_stop", { serverId: "srv-new" }, created)).toBe(true);
    expect(isSessionCreatedStop("servers_stop", { serverId: "live-friend" }, created)).toBe(false);
    expect(isSessionCreatedStop("watchers_delete", { serverId: "srv-new" }, created)).toBe(false);
    expect(isSessionCreatedStop("servers_delete", { serverId: "srv-new" }, created)).toBe(false);
    expect(isSessionCreatedStop("servers_stop", {}, created, "srv-new")).toBe(true);
  });
});
