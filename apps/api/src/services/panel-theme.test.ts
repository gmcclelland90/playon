import { describe, expect, it } from "vitest";
import { themeFromSkill } from "./panel-theme.js";

describe("panel theme", () => {
  it("uses explicit skill theme", () => {
    const t = themeFromSkill({
      name: "games.minecraft-paper",
      game: "Minecraft (Paper)",
      tags: ["minecraft"],
      theme: { id: "paper", primaryHue: 145 },
    });
    expect(t.id).toBe("paper");
    expect(t.primaryHue).toBe(145);
  });

  it("infers paper theme from minecraft tags", () => {
    const t = themeFromSkill({
      name: "games.minecraft-paper",
      tags: ["minecraft", "paper"],
    });
    expect(t.id).toBe("paper");
  });

  it("defaults when no flavour signals", () => {
    const t = themeFromSkill({
      name: "platform.docker-basics",
      tags: ["platform"],
    });
    expect(t.id).toBe("default");
  });
});
