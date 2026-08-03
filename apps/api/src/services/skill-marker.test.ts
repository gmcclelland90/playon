import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSkillMarker,
  readSkillMarker,
  validateSkillMarker,
  writeSkillMarkerFromSkill,
} from "./skill-marker.js";
import { loadSkillMetadata } from "./skills.js";
import { LAB_DOCKER_SKILL, resolveFixturesRoot } from "../lab-games-root.js";

const temps: string[] = [];

afterEach(() => {
  for (const root of temps.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start, "../../..");
}

function fixtureSkill() {
  const gamesRoot = resolveFixturesRoot(findRepoRoot(process.cwd()));
  const skill = loadSkillMetadata([gamesRoot], LAB_DOCKER_SKILL);
  if (!skill) throw new Error("missing fixture skill fixtures.lab-docker-server");
  return skill;
}

describe("SkillMarker", () => {
  it("round-trips write then read for a fixture skill", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-skill-marker-"));
    temps.push(root);
    const dataPath = path.join(root, "server");
    const skill = fixtureSkill();
    const nodeId = "node-abc";

    writeSkillMarkerFromSkill(dataPath, skill, "docker", nodeId);

    const read = readSkillMarker(dataPath);
    expect(read).not.toBeNull();
    const validated = validateSkillMarker(read);
    expect(validated).toEqual(buildSkillMarker(skill, "docker", nodeId));
    expect(fs.existsSync(path.join(dataPath, "game"))).toBe(true);
  });

  it("import-path extras match create-path core fields for a fixture skill", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-skill-marker-"));
    temps.push(root);
    const createPath = path.join(root, "create");
    const importPath = path.join(root, "import");
    const skill = fixtureSkill();
    const runtimeMode = "docker";
    const nodeId = "node-xyz";

    writeSkillMarkerFromSkill(createPath, skill, runtimeMode, nodeId);
    writeSkillMarkerFromSkill(importPath, skill, runtimeMode, nodeId, {
      importedFrom: "/legacy/server",
      importedAt: "2026-08-02T00:00:00.000Z",
    });

    const created = validateSkillMarker(readSkillMarker(createPath)!);
    const importedRaw = readSkillMarker(importPath) as Record<string, unknown>;
    const imported = validateSkillMarker(importedRaw);
    const createCore = validateSkillMarker(buildSkillMarker(skill, runtimeMode, nodeId));

    expect(created).toEqual(createCore);
    expect(imported).toEqual(createCore);
    expect(importedRaw.importedFrom).toBe("/legacy/server");
    expect(importedRaw.importedAt).toBe("2026-08-02T00:00:00.000Z");
  });

  it("returns null when skill.json is missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-skill-marker-"));
    temps.push(root);
    expect(readSkillMarker(root)).toBeNull();
  });
});
