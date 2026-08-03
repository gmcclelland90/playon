import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { PathJailError } from "@playon/runtime";
import type { AppConfig } from "../config.js";
import { createDb, type Db } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { LAB_DOCKER_SKILL, resolveFixturesRoot } from "../lab-games-root.js";
import { buildTestZip, ServerArchiveService } from "./archive-tools.js";
import { ServerService } from "./servers.js";

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

function tempEnv(): {
  db: Db;
  config: AppConfig;
  archives: ServerArchiveService;
  servers: ServerService;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-archive-"));
  const dbPath = path.join(root, "playon.db");
  applyBootstrap(dbPath);
  const config: AppConfig = {
    port: 0,
    dataRoot: root,
    dbPath,
    sessionSecret: "test",
    llmMode: "openai_compatible",
    runtimeMode: "docker",
    advertiseHost: "127.0.0.1",
    skillsRoots: [resolveFixturesRoot(findRepoRoot()), path.join(root, "skills")],
  };
  const { db, sqlite } = createDb(dbPath);
  temps.push({ root, sqlite });
  const servers = new ServerService(db, config);
  return { db, config, servers, archives: new ServerArchiveService(servers) };
}

function tarAvailable(): boolean {
  const result = spawnSync("tar", ["--version"], { encoding: "utf8", windowsHide: true });
  return result.status === 0;
}

afterEach(() => {
  for (const entry of temps.splice(0)) {
    entry.sqlite.close();
    fs.rmSync(entry.root, { recursive: true, force: true });
  }
});

describe("ServerArchiveService", () => {
  it("extracts a zip into the server jail", async () => {
    const { archives, servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: "fixtures.lab-docker-server" });
    const zipPath = path.join(server.dataPath, "mods.zip");
    fs.writeFileSync(
      zipPath,
      buildTestZip({
        "plugins/Hello/config.yml": "enabled: true\n",
        "plugins/Hello/main.lua": "-- hello\n",
      }),
    );

    const result = await archives.extract({
      serverId: server.id,
      archivePath: "mods.zip",
      destDir: "game",
    });
    expect(result.format).toBe("zip");
    expect(result.extracted).toBe(2);
    expect(
      fs.readFileSync(path.join(server.dataPath, "game", "plugins", "Hello", "config.yml"), "utf8"),
    ).toContain("enabled: true");
  });

  it("strips leading path components from zip entries", async () => {
    const { archives, servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: "fixtures.lab-docker-server" });
    fs.writeFileSync(
      path.join(server.dataPath, "pack.zip"),
      buildTestZip({ "ModPack-1.0/mods/foo.jar": "jar-bytes" }),
    );

    await archives.extract({
      serverId: server.id,
      archivePath: "pack.zip",
      destDir: "game/mods",
      stripComponents: 1,
    });
    expect(fs.readFileSync(path.join(server.dataPath, "game", "mods", "mods", "foo.jar"), "utf8")).toBe(
      "jar-bytes",
    );
  });

  it("rejects zip-slip paths", async () => {
    const { archives, servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: "fixtures.lab-docker-server" });
    fs.writeFileSync(
      path.join(server.dataPath, "evil.zip"),
      buildTestZip({ "../escape.txt": "nope" }),
    );

    await expect(
      archives.extract({
        serverId: server.id,
        archivePath: "evil.zip",
        destDir: "game",
      }),
    ).rejects.toThrow(/archive_path_escape|path escapes jail/);
  });

  it("rejects archive paths outside the jail", async () => {
    const { archives, servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: "fixtures.lab-docker-server" });
    await expect(
      archives.extract({
        serverId: server.id,
        archivePath: "../outside.zip",
        destDir: "game",
      }),
    ).rejects.toBeInstanceOf(PathJailError);
  });

  it.runIf(tarAvailable())("extracts a tar.gz into the server jail", async () => {
    const { archives, servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: "fixtures.lab-docker-server" });
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "playon-tarfix-"));
    try {
      fs.mkdirSync(path.join(staging, "payload"), { recursive: true });
      fs.writeFileSync(path.join(staging, "payload", "mod.txt"), "from-tar");
      const archive = path.join(server.dataPath, "mods.tar.gz");
      const packed = spawnSync("tar", ["-czf", archive, "-C", staging, "payload"], {
        encoding: "utf8",
        windowsHide: true,
      });
      expect(packed.status).toBe(0);

      const result = await archives.extract({
        serverId: server.id,
        archivePath: "mods.tar.gz",
        destDir: "game/extracted",
      });
      expect(result.format).toBe("tar.gz");
      expect(result.extracted).toBe(1);
      expect(
        fs.readFileSync(path.join(server.dataPath, "game", "extracted", "payload", "mod.txt"), "utf8"),
      ).toBe("from-tar");
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });
});
