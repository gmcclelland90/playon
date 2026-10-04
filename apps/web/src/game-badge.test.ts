import { describe, expect, it } from "vitest";
import { gameBadgeText, gameHue, oklchToHex } from "./game-badge";

describe("game-badge", () => {
  it("uses word initials for multi-word game ids", () => {
    expect(gameBadgeText("project-zomboid")).toBe("PZ");
    expect(gameBadgeText("minecraft-paper")).toBe("MP");
  });

  it("uses the first two letters for single-word ids and ? for none", () => {
    expect(gameBadgeText("valheim")).toBe("VA");
    expect(gameBadgeText(null)).toBe("?");
  });

  it("returns a stable hue in range, defaulting to brand rose", () => {
    expect(gameHue("valheim")).toBe(gameHue("Valheim"));
    expect(gameHue("rust")).toBeGreaterThanOrEqual(0);
    expect(gameHue("rust")).toBeLessThan(360);
    expect(gameHue(undefined)).toBe(353);
  });

  it("uses curated hues by prefix and keeps hashed hues off brand rose", () => {
    expect(gameHue("minecraft-paper")).toBe(145);
    expect(gameHue("project-zomboid")).toBe(40);
    for (const g of ["mystery-game", "some-other", "xyz", "abc-def"]) {
      const hue = gameHue(g);
      const dist = Math.min(Math.abs(hue - 353), 360 - Math.abs(hue - 353));
      expect(dist).toBeGreaterThanOrEqual(30);
    }
  });

  it("converts OKLCH to sRGB hex", () => {
    expect(oklchToHex(1, 0, 0)).toBe(0xffffff);
    expect(oklchToHex(0, 0, 0)).toBe(0x000000);
    // Brand rose oklch(0.62 0.16 353) ≈ #c94f84
    const rose = oklchToHex(0.62, 0.16, 353);
    expect((rose >> 16) & 0xff).toBeGreaterThan(180);
    expect(rose & 0xff).toBeGreaterThan((rose >> 8) & 0xff);
  });
});
