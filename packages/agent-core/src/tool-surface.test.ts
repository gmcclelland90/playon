import { describe, expect, it } from "vitest";
import * as agentCore from "./index.js";
import {
  createToolSurface,
  projectActivityVerb,
  skillLabel,
  type ToolSurfaceEntry,
} from "./tool-surface.js";

function entry(name: string, meta: Partial<ToolSurfaceEntry> = {}): ToolSurfaceEntry {
  return { name, description: `${name} tool`, parameters: {}, ...meta };
}

describe("tool surface", () => {
  it("projects confirm copy, skill, and XP from the composed catalog", () => {
    const surface = createToolSurface([
      entry("steamcmd_app_update", {
        skill: "installer",
        confirmAction: "download or update game files via Steam",
        activityVerb: "run",
      }),
      entry("rcon_exec", { skill: "configurer", activityVerb: "run" }),
      entry("archive_extract", { skill: "installer", activityVerb: "write" }),
      entry("snapshot_restore", {
        skill: "backup",
        confirmAction: "restore this server from a snapshot",
        xp: { xp: 40, reason: "recovery", celebrate: true },
      }),
    ]);

    expect(surface.confirmAction("steamcmd_app_update")).toBe(
      "download or update game files via Steam",
    );
    expect(surface.skill("rcon_exec")).toBe("configurer");
    expect(surface.get("archive_extract")?.activityVerb).toBe("write");
    expect(surface.xp("snapshot_restore")).toEqual({
      xp: 40,
      reason: "recovery",
      celebrate: true,
    });
    expect(surface.list()).toHaveLength(4);
  });

  it("falls back generically for a tool the catalog does not describe", () => {
    const surface = createToolSurface([]);

    expect(surface.confirmAction("snapshot_restore")).toBe('run "snapshot restore"');
    expect(surface.confirmAction("nodes_add")).toBe('run "nodes add"');
    expect(surface.xp("snapshot_restore")).toEqual({ xp: 5, reason: "tool_success" });
    expect(surface.skill("snapshot_restore")).toBe("orchestrator");
    expect(surface.activityVerb("weird_custom_tool")).toBe("other");
    expect(projectActivityVerb(undefined, "fs_read")).toBe("read");
  });

  it("exposes no ambient surface: metadata cannot be installed process-wide", () => {
    for (const removed of [
      "TOOL_SURFACE_OVERLAY",
      "installToolSurface",
      "getToolSurfaceEntry",
      "listToolSurface",
      "surfaceConfirmAction",
      "surfaceActivityVerb",
      "surfaceXp",
      "surfaceSkill",
    ]) {
      expect(agentCore, `${removed} is still exported`).not.toHaveProperty(removed);
    }
  });

  it("labels skills for UI titles", () => {
    expect(skillLabel("installer")).toBe("Install");
    expect(skillLabel("troubleshooter")).toBe("Fix");
    expect(skillLabel("player_panel")).toBe("Panel");
  });
});
