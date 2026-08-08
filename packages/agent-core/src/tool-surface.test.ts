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
    expect(surfaceConfirmAction("steamcmd_app_update")).toBe(
      "download or update game files via Steam",
    );
    expect(surfaceSkill("nodes_add")).toBe("installer");
    expect(surfaceSkill("rcon_exec")).toBe("configurer");
    expect(surfaceSkill("unknown_tool_xyz")).toBe("orchestrator");
    expect(getToolSurfaceEntry("archive_extract")?.activityVerb).toBe("write");
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
      "snapshot_create",
      "snapshot_restore",
      "snapshot_enforce_retention",
      "backup_offnode",
      "backup_offnode_restore",
    ]) {
      expect(getToolSurfaceEntry(name), `${name} still in the overlay`).toBeUndefined();
    }
    // The process global can only offer generic fallbacks for a migrated tool:
    // real confirm copy and XP have to come from the composed entry.
    expect(surfaceConfirmAction("snapshot_restore")).toBe('run "snapshot restore"');
    expect(surfaceXp("snapshot_restore")).toEqual({ xp: 5, reason: "tool_success" });
    expect(surfaceSkill("snapshot_restore")).toBe("orchestrator");
  });

  it("labels skills for UI titles", () => {
    expect(skillLabel("installer")).toBe("Install");
    expect(skillLabel("troubleshooter")).toBe("Fix");
    expect(skillLabel("player_panel")).toBe("Panel");
  });

  it("overlay covers every key used by projections", () => {
    const names = Object.keys(TOOL_SURFACE_OVERLAY);
    const migratedPrefixes = [
      "backup_offnode",
      "fs_",
      "net_",
      "node_",
      "panel_",
      "servers_",
      "skill_",
      "snapshot_",
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
