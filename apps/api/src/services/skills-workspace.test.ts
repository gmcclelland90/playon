import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listSkills, loadSkillMetadata, skillsRootsForWorkspace } from "./skills.js";

const temps: string[] = [];

afterEach(() => {
  for (const root of temps.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("skillsRootsForWorkspace", () => {
  it("merges global and per-server skill roots", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-skills-"));
    temps.push(root);
    const globalRoot = path.join(root, "skills");
    const serverRoot = path.join(root, "servers", "srv-1", "skills", "local-mod");
    fs.mkdirSync(globalRoot, { recursive: true });
    fs.mkdirSync(serverRoot, { recursive: true });
    fs.writeFileSync(
      path.join(serverRoot, "metadata.yaml"),
      [
        "name: server.local-mod",
        "version: 0.0.1",
        "description: Server-local skill",
        "tags: [server]",
      ].join("\n"),
    );

    const roots = skillsRootsForWorkspace([globalRoot], root, "srv-1");
    const skills = listSkills(roots);
    expect(skills.some((s) => s.metadata.name === "server.local-mod")).toBe(true);
  });
});

describe("listSkills metadata scan (#871)", () => {
  it("coerces unquoted YAML Steam app ids in libraryPathRelative", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-skills-"));
    temps.push(root);
    const skillDir = path.join(root, "ark-evolved");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "metadata.yaml"),
      [
        "name: games.ark-evolved",
        "version: 0.1.4",
        "native:",
        "  binary: ShooterGame/Binaries/Linux/ShooterGameServer",
        "  libraryPathRelative:",
        "    - ShooterGame/Binaries/Linux",
        "    - linux64",
        "    - .",
        "    - ARK Survival Evolved Dedicated Server",
        "    - ARK Survival Evolved Dedicated Server/linux64",
        "    - ARK Survival Evolved Dedicated Server/ShooterGame/Binaries/Linux",
        "    - 376030",
        "    - 376030/linux64",
        "    - 376030/ShooterGame/Binaries/Linux",
      ].join("\n"),
    );

    const paper = loadSkillMetadata([root], "games.ark-evolved");
    expect(paper?.metadata.native?.libraryPathRelative[6]).toBe("376030");
    expect(listSkills([root])).toHaveLength(1);
  });

  it("skips one invalid skill instead of aborting the whole catalog scan", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-skills-"));
    temps.push(root);
    const paperDir = path.join(root, "minecraft-paper");
    const brokenDir = path.join(root, "broken-native");
    fs.mkdirSync(paperDir, { recursive: true });
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(
      path.join(paperDir, "metadata.yaml"),
      ["name: games.minecraft-paper", "version: 0.1.0", "containerSupport: full"].join("\n"),
    );
    fs.writeFileSync(
      path.join(brokenDir, "metadata.yaml"),
      [
        "name: games.broken-native",
        "version: 0.1.0",
        "native:",
        "  libraryPathRelative:",
        "    - linux64",
        "    - { not: a path }",
      ].join("\n"),
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const skills = listSkills([root]);
      expect(skills.map((s) => s.metadata.name)).toEqual(["games.minecraft-paper"]);
      expect(loadSkillMetadata([root], "games.minecraft-paper")?.metadata.name).toBe(
        "games.minecraft-paper",
      );
      expect(warn.mock.calls.join(" ")).toMatch(/skipping invalid skill metadata/);
      expect(warn.mock.calls.join(" ")).toMatch(/libraryPathRelative/);
    } finally {
      warn.mockRestore();
    }
  });
});
