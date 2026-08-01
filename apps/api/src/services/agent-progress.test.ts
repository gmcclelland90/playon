import { describe, expect, it } from "vitest";
import { levelFromXp, titleFor } from "./agent-progress.js";

describe("agent progress math", () => {
  it("levels up as XP accumulates", () => {
    expect(levelFromXp(0)).toBe(1);
    expect(levelFromXp(99)).toBe(1);
    expect(levelFromXp(100)).toBe(2);
    expect(levelFromXp(500)).toBeGreaterThan(2);
  });

  it("titles reflect level bands", () => {
    expect(titleFor("installer", 1)).toContain("Rookie");
    expect(titleFor("backup", 5)).toContain("Operator");
    expect(titleFor("troubleshooter", 12)).toContain("Legend");
  });
});
