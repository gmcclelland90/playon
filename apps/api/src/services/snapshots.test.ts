import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupSnapshotTemps,
  insertServer,
  tempEnv,
} from "./snapshots-test-helpers.js";

/**
 * Split from snapshots-node-sync.test.ts so no single Windows CI file sits near
 * the ~60s vitest birpc onTaskUpdate cliff (#912 / vitest#6511).
 */
const sync = vi.hoisted(() => ({
  pulls: [] as string[],
  pushes: [] as string[],
}));

vi.mock("./node-sync.js", () => ({
  pullServerDirFromNode: async (opts: { serverId: string; localDataPath: string }) => {
    sync.pulls.push(opts.serverId);
    fs.mkdirSync(opts.localDataPath, { recursive: true });
    fs.writeFileSync(path.join(opts.localDataPath, "from-node.txt"), "node-bytes");
  },
  pushServerDirToNode: async (opts: { serverId: string }) => {
    sync.pushes.push(opts.serverId);
  },
}));

afterEach(() => {
  sync.pulls.length = 0;
  sync.pushes.length = 0;
  cleanupSnapshotTemps();
});

describe("SnapshotService local", () => {
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
