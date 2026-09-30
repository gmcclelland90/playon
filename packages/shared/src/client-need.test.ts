import { describe, expect, it } from "vitest";
import {
  clientNeedPlayerCopy,
  experienceClientNeed,
  worstClientNeed,
} from "./index.js";

describe("clientNeed helpers", () => {
  it("ranks manual over auto over none", () => {
    expect(worstClientNeed(["none", "auto"])).toBe("auto");
    expect(worstClientNeed(["manual", "auto", "none"])).toBe("manual");
    expect(worstClientNeed([])).toBe("none");
  });

  it("returns player copy for each need", () => {
    expect(clientNeedPlayerCopy("none").label).toMatch(/No extra/i);
    expect(clientNeedPlayerCopy("auto").steps.length).toBeGreaterThan(0);
    expect(clientNeedPlayerCopy("manual").label).toMatch(/Manual/i);
  });

  it("experienceClientNeed uses panel override or worst mod", () => {
    const base = {
      name: "experiences.demo",
      version: "1.0.0",
      displayName: "Demo",
      description: "",
      baseGame: "games.project-zomboid",
      mods: [
        { modId: "A", dialect: "project-zomboid" as const, clientNeed: "none" as const },
        { modId: "B", dialect: "project-zomboid" as const, clientNeed: "auto" as const },
      ],
      overlays: [],
      seedFiles: [],
      schemaVersion: 1 as const,
    };
    expect(experienceClientNeed(base)).toBe("auto");
    expect(
      experienceClientNeed({
        ...base,
        panel: { clientNeed: "manual", summary: "x" },
      }),
    ).toBe("manual");
  });
});
