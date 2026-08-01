import { describe, expect, it } from "vitest";
import { ACHIEVEMENT_CATALOG, looksModded } from "./host-achievements.js";

describe("host achievements", () => {
  it("catalog covers LAN party milestones", () => {
    const ids = ACHIEVEMENT_CATALOG.map((a) => a.id);
    expect(ids).toContain("first_modded");
    expect(ids).toContain("zero_downtime_lan");
    expect(ids).toContain("multi_node");
  });

  it("detects modded skills and import hints", () => {
    expect(looksModded({ skillTags: ["minecraft", "paper"] })).toBe(true);
    expect(looksModded({ skillName: "games.minecraft-paper" })).toBe(true);
    expect(looksModded({ hints: ["has_mods_or_plugins"] })).toBe(true);
    expect(looksModded({ skillTags: ["vanilla", "reference"] })).toBe(false);
  });
});
