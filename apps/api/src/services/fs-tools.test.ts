import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { PathJailError } from "@playon/runtime";
import type { AppConfig } from "../config.js";
import { createDb, type Db } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { ServerFsService } from "./fs-tools.js";
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

function tempEnv(): { db: Db; config: AppConfig; fsTools: ServerFsService; servers: ServerService } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-fs-"));
  const dbPath = path.join(root, "playon.db");
  applyBootstrap(dbPath);
  const repoRoot = findRepoRoot();
  const config: AppConfig = {
    port: 0,
    dataRoot: root,
    dbPath,
    sessionSecret: "test",
    llmMode: "openai_compatible",
    runtimeMode: "docker",
    advertiseHost: "127.0.0.1",
    skillsRoots: [
      path.join(repoRoot, "skills", "games"),
      path.join(root, "skills"),
    ],
  };
  const { db, sqlite } = createDb(dbPath);
  temps.push({ root, sqlite });
  const servers = new ServerService(db, config);
  return { db, config, servers, fsTools: new ServerFsService(servers) };
}

afterEach(() => {
  for (const entry of temps.splice(0)) {
    entry.sqlite.close();
    fs.rmSync(entry.root, { recursive: true, force: true });
  }
});

describe("ServerFsService", () => {
  it("reads and writes inside the server jail", async () => {
    const { fsTools, servers } = tempEnv();
    const server = await servers.createFromSkill({
      skillName: "games.minecraft-paper",
      serverName: "FS Test",
    });

    await fsTools.write(server.id, "game/motd.txt", "hello lan");
    const read = await fsTools.read(server.id, "game/motd.txt");
    expect(read.content).toBe("hello lan");

    const listing = await fsTools.list(server.id, "game");
    expect(listing.some((e) => e.name === "motd.txt")).toBe(true);
  });

  it("blocks path escape attempts", async () => {
    const { fsTools, servers } = tempEnv();
    const server = await servers.createFromSkill({
      skillName: "games.minecraft-paper",
    });

    await expect(fsTools.read(server.id, "../escape.txt")).rejects.toBeInstanceOf(PathJailError);
    await expect(fsTools.write(server.id, "../../x", "nope")).rejects.toBeInstanceOf(PathJailError);
  });
});
