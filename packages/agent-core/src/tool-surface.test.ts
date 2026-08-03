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
    expect(surfaceConfirmAction("servers_stop")).toBe("stop this server");
    expect(surfaceXp("servers_create_from_skill")).toEqual({
      xp: 50,
      reason: "clean_install",
      celebrate: true,
    });
    expect(surfaceSkill("servers_create_from_skill")).toBe("installer");
    expect(surfaceSkill("panel_publish")).toBe("player_panel");
    expect(surfaceSkill("snapshot_restore")).toBe("backup");
    expect(surfaceSkill("unknown_tool_xyz")).toBe("orchestrator");
    expect(getToolSurfaceEntry("snapshot_enforce_retention")?.activityVerb).toBe("snapshot");
  });

  it("labels skills for UI titles", () => {
    expect(skillLabel("installer")).toBe("Install");
    expect(skillLabel("troubleshooter")).toBe("Fix");
    expect(skillLabel("player_panel")).toBe("Panel");
  });

  it("overlay covers every key used by projections", () => {
    expect(Object.keys(TOOL_SURFACE_OVERLAY).length).toBeGreaterThan(40);
  });
});
