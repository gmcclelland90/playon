import { describe, expect, it } from "vitest";
import {
  getToolSurfaceEntry,
  skillLabel,
  surfaceConfirmAction,
  surfaceSkill,
  surfaceXp,
} from "./tool-surface.js";
import { TOOL_SURFACE_OVERLAY } from "./tool-surface-overlay.js";

describe("tool surface", () => {
  it("bootstraps overlay so confirm, skill, and XP projections work", () => {
    expect(surfaceConfirmAction("snapshot_restore")).toBe("restore this server from a snapshot");
    expect(surfaceXp("snapshot_restore")).toEqual({
      xp: 40,
      reason: "recovery",
      celebrate: true,
    });
    expect(surfaceSkill("nodes_add")).toBe("installer");
    expect(surfaceSkill("rcon_exec")).toBe("configurer");
    expect(surfaceSkill("snapshot_restore")).toBe("backup");
    expect(surfaceSkill("unknown_tool_xyz")).toBe("orchestrator");
    expect(getToolSurfaceEntry("snapshot_enforce_retention")?.activityVerb).toBe("snapshot");
  });

  it("drops migrated domains so their metadata can only come from the entry", () => {
    for (const name of [
      "fs_write",
      "node_ping",
      "servers_start",
      "servers_delete",
      "skill_promote",
      "skill_install_url",
      "panel_publish",
      "watchers_create",
      "watchers_runs_list",
    ]) {
      expect(getToolSurfaceEntry(name), `${name} still in the overlay`).toBeUndefined();
    }
  });

  it("labels skills for UI titles", () => {
    expect(skillLabel("installer")).toBe("Install");
    expect(skillLabel("troubleshooter")).toBe("Fix");
    expect(skillLabel("player_panel")).toBe("Panel");
  });

  it("overlay covers every key used by projections", () => {
    const names = Object.keys(TOOL_SURFACE_OVERLAY);
    const migratedPrefixes = [
      "fs_",
      "net_",
      "node_",
      "panel_",
      "servers_",
      "skill_",
      "watchers_",
    ];
    expect(names.length).toBeGreaterThan(0);
    expect(
      names.filter((name) => migratedPrefixes.some((prefix) => name.startsWith(prefix))),
    ).toEqual([]);
    for (const [name, meta] of Object.entries(TOOL_SURFACE_OVERLAY)) {
      expect(meta.skill, `${name} has no skill`).toBeDefined();
      expect(meta.activityVerb, `${name} has no activityVerb`).toBeDefined();
    }
  });
});
