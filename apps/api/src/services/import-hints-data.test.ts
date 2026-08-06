import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadImportHintRules, loadImportScanRoots } from "./import-hints-data.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../");
const skillsRoot = path.join(repoRoot, "skills");

describe("import-hints-data", () => {
  it("loads Zomboid fingerprint from import-hints.yaml", () => {
    const hints = loadImportHintRules([skillsRoot]);
    const z = hints.find((h) => h.id === "project_zomboid_layout");
    expect(z).toBeTruthy();
    expect(z?.suggestedSkillName).toBe("games.project-zomboid");
    expect(z?.anyFiles.length).toBeGreaterThan(0);
  });

  it("loads linux scan roots including Zomboid homes", () => {
    const roots = loadImportScanRoots([skillsRoot], "linux");
    expect(roots.some((r) => r.includes("Zomboid"))).toBe(true);
    expect(roots.some((r) => r.includes("steamapps"))).toBe(true);
  });
});
