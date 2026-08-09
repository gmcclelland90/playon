import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureSkillGameOverlay } from "./skill-game-overlay.js";

describe("ensureSkillGameOverlay", () => {
  it("copies missing skill files/ into game/ and skips existing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-overlay-"));
    const skillPath = path.join(root, "skill");
    const gameDir = path.join(root, "game");
    fs.mkdirSync(path.join(skillPath, "files", "nested"), { recursive: true });
    fs.writeFileSync(path.join(skillPath, "files", "a.json"), '{"a":1}\n');
    fs.writeFileSync(path.join(skillPath, "files", "nested", "b.txt"), "b\n");
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(gameDir, "a.json"), '{"keep":true}\n');

    const copied = ensureSkillGameOverlay(skillPath, gameDir);
    expect(copied).toEqual(["nested/b.txt"]);
    expect(fs.readFileSync(path.join(gameDir, "a.json"), "utf8")).toContain("keep");
    expect(fs.readFileSync(path.join(gameDir, "nested", "b.txt"), "utf8")).toBe("b\n");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("no-ops when skill has no files/", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-overlay-empty-"));
    const skillPath = path.join(root, "skill");
    const gameDir = path.join(root, "game");
    fs.mkdirSync(skillPath, { recursive: true });
    fs.mkdirSync(gameDir, { recursive: true });
    expect(ensureSkillGameOverlay(skillPath, gameDir)).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
