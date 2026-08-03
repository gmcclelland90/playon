import { describe, expect, it } from "vitest";
import {
  derivePersonaAllowlist,
  getToolSurfaceEntry,
  surfaceConfirmAction,
  surfaceXp,
} from "./tool-surface.js";
import { TOOL_SURFACE_OVERLAY } from "./tool-surface-overlay.js";
import { PERSONA_TOOL_ALLOWLIST, toolsAllowedForPersona } from "./personas.js";

describe("tool surface", () => {
  it("bootstraps overlay so confirm and XP projections work", () => {
    expect(surfaceConfirmAction("servers_stop")).toBe("stop this server");
    expect(surfaceXp("servers_create_from_skill")).toEqual({
      xp: 50,
      reason: "clean_install",
      celebrate: true,
    });
    expect(getToolSurfaceEntry("snapshot_enforce_retention")?.activityVerb).toBe("snapshot");
  });

  it("derives persona allowlists from surface", () => {
    const derived = derivePersonaAllowlist();
    expect(derived.orchestrator).toBeNull();
    expect(derived.player_panel).toEqual(
      expect.arrayContaining(["panel_list", "panel_publish", "servers_list"]),
    );
    expect(PERSONA_TOOL_ALLOWLIST.installer).toEqual(
      expect.arrayContaining(["servers_create_from_skill", "steamcmd_app_update"]),
    );
  });

  it("gates specialists via surface personas", () => {
    expect(toolsAllowedForPersona("player_panel", "panel_publish")).toBe(true);
    expect(toolsAllowedForPersona("player_panel", "servers_delete")).toBe(false);
    expect(toolsAllowedForPersona("orchestrator", "servers_delete")).toBe(true);
  });

  it("overlay covers every key used by projections", () => {
    expect(Object.keys(TOOL_SURFACE_OVERLAY).length).toBeGreaterThan(40);
  });
});
