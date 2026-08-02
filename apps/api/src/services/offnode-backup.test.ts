import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import type { AppConfig } from "../config.js";
import { OffNodeBackupService } from "./offnode-backup.js";
import { ServerService } from "./servers.js";
import { SnapshotService } from "./snapshots.js";

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
  offNode: OffNodeBackupService;
  servers: ServerService;
  snapshots: SnapshotService;
  backupRoot: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-offnode-"));
  const backupRoot = path.join(root, "ext-backups");
  const dbPath = path.join(root, "playon.db");
  applyBootstrap(dbPath);
  const { db, sqlite } = createDb(dbPath);
  temps.push({ root, sqlite });
  const config: AppConfig = {
    port: 0,
    dataRoot: root,
    dbPath,
    sessionSecret: "test",
    llmMode: "openai_compatible",
    runtimeMode: "docker",
    advertiseHost: "127.0.0.1",
    skillsRoots: [path.join(root, "skills")],
    backupRoot,
  };
  fs.mkdirSync(path.join(root, "skills"), { recursive: true });
  // minimal skill for createFromSkill
  const skillDir = path.join(root, "skills", "demo");
  fs.mkdirSync(path.join(skillDir, "guides"), { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "metadata.yaml"),
    [
      "name: demo.offnode",
      "version: 1.0.0",
      "game: Demo",
      "description: offnode test",
      "tags: []",
      "containerSupport: none",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(skillDir, "guides", "INSTALL.md"), "# x\n");

  const servers = new ServerService(db, config);
  const snapshots = new SnapshotService(db, config, servers);
  const offNode = new OffNodeBackupService(db, config, snapshots);
  return { db, config, offNode, servers, snapshots, backupRoot };
}

describe("OffNodeBackupService", () => {
  it("exports a durable backup and restores from the external root", async () => {
    const { offNode, servers, backupRoot } = tempEnv();
    await offNode.setTarget(backupRoot);
    const server = await servers.createFromSkill({ skillName: "demo.offnode" });
    fs.writeFileSync(path.join(server.dataPath, "game", "world.txt"), "precious");

    const exported = await offNode.backupServer(server.id, "backup-lan");
    expect(exported.label).toContain("backup");
    expect(fs.existsSync(path.join(exported.path, "OFFNODE.json"))).toBe(true);
    expect(fs.existsSync(path.join(exported.path, "files", "game", "world.txt"))).toBe(true);

    fs.writeFileSync(path.join(server.dataPath, "game", "world.txt"), "corrupted");
    const restored = await offNode.restore(exported.id);
    expect(restored.serverId).toBe(server.id);
    expect(fs.readFileSync(path.join(server.dataPath, "game", "world.txt"), "utf8")).toBe(
      "precious",
    );
  });
});
