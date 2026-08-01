import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import type { AppConfig } from "../config.js";
import { ImportSftpService } from "./import-sftp.js";
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
  importer: ImportSftpService;
  root: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-sftp-"));
  const dbPath = path.join(root, "playon.db");
  applyBootstrap(dbPath);
  const { db, sqlite } = createDb(dbPath);
  temps.push({ root, sqlite });
  const config: AppConfig = {
    port: 0,
    dataRoot: path.join(root, "data"),
    dbPath,
    sessionSecret: "test",
    llmMode: "mock",
    runtimeMode: "mock",
    advertiseHost: "127.0.0.1",
    skillsRoots: [path.join(root, "data", "skills")],
  };
  fs.mkdirSync(path.join(config.dataRoot, "skills"), { recursive: true });
  const servers = new ServerService(db, config);
  const snapshots = new SnapshotService(db, config, servers);
  const importer = new ImportSftpService(db, config, servers, snapshots, async (args) => {
    // Fake "remote" payload written into the staging directory.
    fs.mkdirSync(args.localPath, { recursive: true });
    fs.writeFileSync(path.join(args.localPath, "server.properties"), "motd=sftp\n");
    fs.writeFileSync(path.join(args.localPath, "world.dat"), "remote-world");
  });
  return { db, config, importer, root };
}

describe("ImportSftpService", () => {
  it("stages a remote tree then runs local import", async () => {
    const { importer } = tempEnv();
    const report = await importer.importFromSftp({
      host: "fake.example",
      username: "lan",
      password: "secret",
      remotePath: "/home/lan/server",
      serverName: "SFTP Import",
      game: "Imported Game",
    });
    expect(report.server.name).toBe("SFTP Import");
    expect(report.remoteHost).toBe("fake.example");
    expect(report.followUp).toContain("imported_via_sftp");
    expect(fs.existsSync(path.join(report.server.dataPath, "game", "world.dat"))).toBe(true);
    expect(report.baselineSnapshotId.length).toBeGreaterThan(0);
  });

  it("requires credentials", async () => {
    const { importer } = tempEnv();
    await expect(
      importer.importFromSftp({
        host: "h",
        username: "u",
        remotePath: "/x",
      }),
    ).rejects.toThrow(/password_or_private_key/);
  });
});
