import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import type { AppConfig } from "../config.js";
import { detectImportHints, ImportLocalService } from "./import-local.js";
import { ServerService } from "./servers.js";
import { SnapshotService } from "./snapshots.js";
import { listSkills } from "./skills.js";

const temps: Array<{ root: string; sqlite: Database.Database }> = [];

afterEach(() => {
  for (const entry of temps.splice(0)) {
    entry.sqlite.close();
    fs.rmSync(entry.root, { recursive: true, force: true });
  }
});

function tempEnv(): {
  db: Db;
  config: AppConfig;
  importer: ImportLocalService;
  root: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-import-"));
  const dbPath = path.join(root, "playon.db");
  applyBootstrap(dbPath);
  const { db, sqlite } = createDb(dbPath);
  temps.push({ root, sqlite });
  const config: AppConfig = {
    port: 0,
    dataRoot: path.join(root, "data"),
    dbPath,
    sessionSecret: "test",
    llmMode: "openai_compatible",
    runtimeMode: "docker",
    advertiseHost: "127.0.0.1",
    skillsRoots: [path.join(root, "data", "skills")],
  };
  fs.mkdirSync(config.dataRoot, { recursive: true });
  fs.mkdirSync(path.join(config.dataRoot, "skills"), { recursive: true });
  const servers = new ServerService(db, config);
  const snapshots = new SnapshotService(db, config, servers);
  const importer = new ImportLocalService(db, config, servers, snapshots);
  return { db, config, importer, root };
}

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

describe("detectImportHints", () => {
  it("detects minecraft paper layouts via import-hints.yaml", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-"));
    try {
      fs.writeFileSync(path.join(dir, "server.properties"), "motd=hi\n");
      fs.writeFileSync(path.join(dir, "paper.yml"), "x: 1\n");
      const gamesRoot = path.join(findRepoRoot(process.cwd()), "skills", "platform");
      const hints = detectImportHints(dir, [gamesRoot]);
      expect(hints.suggestedSkillName).toBe("games.minecraft-paper");
      expect(hints.hints).toContain("minecraft_java_layout");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ImportLocalService", () => {
  it("copies a local tree, scaffolds a draft skill, and baselines", async () => {
    const { config, importer, root } = tempEnv();
    const source = path.join(root, "legacy-server");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "world.dat"), "save");
    fs.mkdirSync(path.join(source, "plugins"));
    fs.writeFileSync(path.join(source, "plugins", "mod.jar"), "jar");

    const report = await importer.importFromPath({
      sourcePath: source,
      serverName: "Legacy",
      game: "Mystery Game",
    });

    expect(report.server.name).toBe("Legacy");
    expect(report.skillSource).toBe("draft");
    expect(report.draftSlug).toBeTruthy();
    expect(report.baselineSnapshotId.length).toBeGreaterThan(0);
    expect(report.copiedBytes).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(report.server.dataPath, "game", "world.dat"))).toBe(true);
    expect(report.followUp).toContain("review_and_promote_draft_skill");
    expect(listSkills(config.skillsRoots).some((s) => s.metadata.name === report.skillName)).toBe(
      true,
    );
  });
});
