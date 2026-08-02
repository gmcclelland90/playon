import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { AppConfig } from "../config.js";
import { createDb, type Db } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { createOrReinstallFromSkill } from "./tools.js";
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

function tempEnv(): { db: Db; config: AppConfig; servers: ServerService } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-reinstall-"));
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
    skillsRoots: [path.join(repoRoot, "skills", "games"), path.join(root, "skills")],
  };
  const { db, sqlite } = createDb(dbPath);
  temps.push({ root, sqlite });
  return { db, config, servers: new ServerService(db, config) };
}

afterEach(() => {
  for (const entry of temps.splice(0)) {
    entry.sqlite.close();
    fs.rmSync(entry.root, { recursive: true, force: true });
  }
});

describe("reinstallFromSkill / createOrReinstallFromSkill", () => {
  it("keeps the same server id when switching skills", async () => {
    const { servers } = tempEnv();
    const first = await servers.createFromSkill({
      skillName: "games.minecraft-paper",
      serverName: "LAN MC",
    });
    fs.writeFileSync(path.join(first.dataPath, "game", "marker.txt"), "old");

    const second = await servers.reinstallFromSkill(first.id, {
      skillName: "games.minecraft-paper",
      serverName: "LAN MC 2",
    });

    expect(second.id).toBe(first.id);
    expect(second.name).toBe("LAN MC 2");
    expect(second.status).toBe("stopped");
    expect(fs.existsSync(path.join(first.dataPath, "game", "marker.txt"))).toBe(false);
    expect(fs.existsSync(path.join(first.dataPath, "skill.json"))).toBe(true);
  });

  it("binds unbound chat on first create and reinstalls on second", async () => {
    const { servers } = tempEnv();
    const workspace = { serverId: undefined as string | undefined };

    const a = await createOrReinstallFromSkill(servers, workspace, {
      skillName: "games.minecraft-paper",
      serverName: "One",
    });
    expect(a.mode).toBe("created");
    expect(workspace.serverId).toBe(a.server.id);

    const b = await createOrReinstallFromSkill(servers, workspace, {
      skillName: "games.minecraft-paper",
      serverName: "Two",
    });
    expect(b.mode).toBe("reinstalled");
    expect(b.server.id).toBe(a.server.id);
    expect(b.server.name).toBe("Two");

    const listed = await servers.list();
    expect(listed).toHaveLength(1);
  });
});
