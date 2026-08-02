import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb, type Db } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { servers } from "../db/schema.js";
import type { AppConfig } from "../config.js";
import { ServerService } from "./servers.js";
import { SnapshotService } from "./snapshots.js";

const temps: Array<{ root: string; sqlite: Database.Database }> = [];

function tempEnv(): {
  db: Db;
  config: AppConfig;
  servers: ServerService;
  snapshots: SnapshotService;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-snap-"));
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
    skillsRoots: [path.join(root, "skills")],
  };
  const { db, sqlite } = createDb(dbPath);
  temps.push({ root, sqlite });
  const serverService = new ServerService(db, config);
  const snapshotService = new SnapshotService(db, config, serverService);
  return { db, config, servers: serverService, snapshots: snapshotService };
}

async function insertServer(
  db: Db,
  config: AppConfig,
  id: string,
  contents: Record<string, string>,
): Promise<string> {
  const dataPath = path.join(config.dataRoot, "servers", id);
  fs.mkdirSync(dataPath, { recursive: true });
  for (const [name, body] of Object.entries(contents)) {
    fs.writeFileSync(path.join(dataPath, name), body);
  }
  await db.insert(servers).values({
    id,
    name: `Server ${id}`,
    game: "test",
    nodeId: null,
    runtimeMode: "docker",
    status: "stopped",
    dataPath,
    createdAt: new Date(),
  });
  return dataPath;
}

afterEach(() => {
  for (const entry of temps.splice(0)) {
    entry.sqlite.close();
    fs.rmSync(entry.root, { recursive: true, force: true });
  }
});

describe("SnapshotService", () => {
  it("enforces retention on scheduled snapshots but keeps baselines", async () => {
    const { db, config, snapshots } = tempEnv();
    await insertServer(db, config, "srv-ret", { "a.txt": "1" });

    await snapshots.create("srv-ret", "baseline");
    const s1 = await snapshots.create("srv-ret", "scheduled-1");
    const s2 = await snapshots.create("srv-ret", "scheduled-2");
    const s3 = await snapshots.create("srv-ret", "scheduled-3");

    const result = await snapshots.enforceRetention("srv-ret", {
      maxCount: 2,
      maxAgeHours: 9999,
    });
    expect(result.removed.length).toBeGreaterThanOrEqual(1);
    const left = await snapshots.list("srv-ret");
    expect(left.some((s) => s.label === "baseline")).toBe(true);
    expect(left.filter((s) => s.label.startsWith("scheduled-")).length).toBeLessThanOrEqual(2);
    expect(left.some((s) => s.id === s1.id) || left.some((s) => s.id === s2.id) || left.some((s) => s.id === s3.id)).toBe(
      true,
    );
  });

  it("creates and restores server files", async () => {
    const { db, config, snapshots } = tempEnv();
    const dataPath = await insertServer(db, config, "srv1", { "config.txt": "original" });

    const created = await snapshots.create("srv1", "before-change");
    expect(created.label).toBe("before-change");
    expect(fs.existsSync(path.join(created.path, "files", "config.txt"))).toBe(true);

    fs.writeFileSync(path.join(dataPath, "config.txt"), "mutated");

    const restored = await snapshots.restore(created.id);
    expect(restored.id).toBe("srv1");
    expect(fs.readFileSync(path.join(dataPath, "config.txt"), "utf8")).toBe("original");
  });

  it("lists snapshots for a server", async () => {
    const { db, config, snapshots } = tempEnv();
    await insertServer(db, config, "srv2", { "keep.txt": "ok" });

    await snapshots.create("srv2", "one");
    await snapshots.create("srv2", "two");

    const listed = await snapshots.list("srv2");
    expect(listed.map((s) => s.label).sort()).toEqual(["one", "two"]);
  });
});
