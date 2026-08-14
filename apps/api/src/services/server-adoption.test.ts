import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import type { AppConfig } from "../config.js";
import { LAB_DOCKER_SKILL, resolveFixturesRoot } from "../lab-games-root.js";
import { ServerAdoptionService } from "./server-adoption.js";
import { readSkillMarker } from "./skill-marker.js";
import { ServerService } from "./servers.js";
import { SnapshotService } from "./snapshots.js";

const temps: Array<{ root: string; sqlite: Database.Database }> = [];

function findRepoRoot(): string {
  let dir = path.resolve(process.cwd());
  while (true) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

afterEach(() => {
  for (const entry of temps.splice(0)) {
    entry.sqlite.close();
    fs.rmSync(entry.root, { recursive: true, force: true });
  }
});

function tempEnv(): {
  db: Db;
  config: AppConfig;
  servers: ServerService;
  adoption: ServerAdoptionService;
  snapshots: SnapshotService;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-adoption-"));
  const dbPath = path.join(root, "playon.db");
  applyBootstrap(dbPath);
  const repoRoot = findRepoRoot();
  const config: AppConfig = {
    port: 0,
    dataRoot: path.join(root, "data"),
    dbPath,
    sessionSecret: "test",
    llmMode: "openai_compatible",
    runtimeMode: "docker",
    advertiseHost: "127.0.0.1",
    skillsRoots: [resolveFixturesRoot(repoRoot), path.join(root, "data", "skills")],
  };
  fs.mkdirSync(config.dataRoot, { recursive: true });
  const { db, sqlite } = createDb(dbPath);
  temps.push({ root, sqlite });
  const servers = new ServerService(db, config);
  const snapshots = new SnapshotService(db, config, servers);
  const adoption = new ServerAdoptionService(db, config, servers, snapshots);
  servers.bindAdoption(adoption);
  return { db, config, servers, adoption, snapshots };
}

describe("ServerAdoptionService.resolveRuntimeMode", () => {
  it("uses docker on a remote node even when Home is native", () => {
    const { adoption, config } = tempEnv();
    config.runtimeMode = "native";
    expect(adoption.resolveRuntimeMode("full", { nodeId: "playon-win-1" })).toBe("docker");
    expect(adoption.resolveRuntimeMode("none", { nodeId: "playon-win-1" })).toBe("native");
    expect(adoption.resolveRuntimeMode("full", { nodeId: "local" })).toBe("native");
  });
});

describe("ServerAdoptionService", () => {
  it("createFromSkill ensures game dir via File Store and writes marker", async () => {
    const { adoption } = tempEnv();
    const server = await adoption.createFromSkill({
      skillName: LAB_DOCKER_SKILL,
      serverName: "Adopt Me",
    });

    expect(server.name).toBe("Adopt Me");
    expect(fs.existsSync(path.join(server.dataPath, "game"))).toBe(true);
    expect(fs.statSync(path.join(server.dataPath, "game")).isDirectory()).toBe(true);
    const marker = readSkillMarker(server.dataPath);
    expect(marker?.skillName).toBe(LAB_DOCKER_SKILL);
  });

  it("adoptLocalTree copies external content, markers, and baselines", async () => {
    const { adoption, config } = tempEnv();
    const source = path.join(config.dataRoot, "..", "legacy");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "world.dat"), "save");

    const skillRoots = config.skillsRoots;
    const { loadSkillMetadata } = await import("./skills.js");
    const skill = loadSkillMetadata(skillRoots, LAB_DOCKER_SKILL);
    if (!skill) throw new Error("missing lab skill");

    const target = await adoption.resolveTarget(LAB_DOCKER_SKILL);
    const result = await adoption.adoptLocalTree({
      sourcePath: source,
      skill,
      nodeId: target.nodeId,
      runtimeMode: target.runtimeMode,
      serverName: "Imported",
      gameLabel: "Lab",
      markerExtras: { importedFrom: source },
    });

    expect(result.copiedBytes).toBeGreaterThan(0);
    expect(result.baselineSnapshotId.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(result.dataPath, "game", "world.dat"))).toBe(true);
    const marker = readSkillMarker(result.dataPath);
    expect(marker?.skillName).toBe(LAB_DOCKER_SKILL);
  });

  it("servers.createFromSkill delegates through adoption", async () => {
    const { servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });
    expect(fs.existsSync(path.join(server.dataPath, "skill.json"))).toBe(true);
    expect(fs.existsSync(path.join(server.dataPath, "game"))).toBe(true);
  });
});
