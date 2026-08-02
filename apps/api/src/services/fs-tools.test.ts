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
    await expect(fsTools.delete(server.id, "../escape")).rejects.toBeInstanceOf(PathJailError);
    await expect(fsTools.rename(server.id, "game", "../out")).rejects.toBeInstanceOf(PathJailError);
    await expect(fsTools.copy(server.id, "game", "../out")).rejects.toBeInstanceOf(PathJailError);
  });

  it("deletes, renames, and copies inside the jail", async () => {
    const { fsTools, servers } = tempEnv();
    const server = await servers.createFromSkill({
      skillName: "games.minecraft-paper",
      serverName: "FS Mutate",
    });

    await fsTools.write(server.id, "game/a.txt", "alpha");
    await fsTools.write(server.id, "game/subdir/b.txt", "beta");

    await fsTools.copy(server.id, "game/a.txt", "game/a-copy.txt");
    expect(fs.readFileSync(path.join(server.dataPath, "game", "a-copy.txt"), "utf8")).toBe("alpha");

    await fsTools.rename(server.id, "game/a-copy.txt", "game/a-moved.txt");
    expect(fs.existsSync(path.join(server.dataPath, "game", "a-copy.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(server.dataPath, "game", "a-moved.txt"), "utf8")).toBe("alpha");

    await expect(fsTools.copy(server.id, "game/a.txt", "game/a-moved.txt")).rejects.toThrow(
      /already_exists/,
    );
    await fsTools.copy(server.id, "game/a.txt", "game/a-moved.txt", { overwrite: true });

    await fsTools.copy(server.id, "game/subdir", "game/subdir-copy");
    expect(fs.readFileSync(path.join(server.dataPath, "game", "subdir-copy", "b.txt"), "utf8")).toBe(
      "beta",
    );

    const delFile = await fsTools.delete(server.id, "game/a-moved.txt");
    expect(delFile.deleted).toBe("file");
    const delDir = await fsTools.delete(server.id, "game/subdir-copy");
    expect(delDir.deleted).toBe("dir");
    expect(fs.existsSync(path.join(server.dataPath, "game", "subdir-copy"))).toBe(false);
  });

  it("reads with offset and maxBytes", async () => {
    const { fsTools, servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: "games.minecraft-paper" });
    await fsTools.write(server.id, "game/chunk.txt", "abcdefghij");

    const mid = await fsTools.read(server.id, "game/chunk.txt", { offset: 3, maxBytes: 4 });
    expect(mid.content).toBe("defg");
    expect(mid.bytesRead).toBe(4);
    expect(mid.truncated).toBe(true);
    expect(mid.size).toBe(10);

    const full = await fsTools.read(server.id, "game/chunk.txt");
    expect(full.content).toBe("abcdefghij");
    expect(full.truncated).toBe(false);
  });
});
