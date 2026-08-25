import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupSnapshotTemps,
  insertServer,
  tempEnv,
} from "./snapshots-test-helpers.js";

/**
 * Node pull/push cases live here (not in snapshots.test.ts) so Windows CI does
 * not pack ~47s of SQLite/fs work into one vitest file near the birpc timeout
 * (#912 / vitest#6511).
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

describe("SnapshotService node sync", () => {
  it("pulls node-authoritative trees before create", async () => {
    const { db, config, snapshots } = tempEnv();
    await insertServer(db, config, "srv-na", { "stale.txt": "home" }, {
      nodeId: "node-z",
      nodeAuthoritative: true,
    });

    const created = await snapshots.create("srv-na", "from-node");

    expect(sync.pulls).toEqual(["srv-na"]);
    expect(fs.readFileSync(path.join(created.path, "files", "from-node.txt"), "utf8")).toBe(
      "node-bytes",
    );
  });

  it("pushes restored trees to remote nodes", async () => {
    const { db, config, snapshots } = tempEnv();
    const dataPath = await insertServer(db, config, "srv-r", { "config.txt": "v1" }, {
      nodeId: "node-z",
    });

    const created = await snapshots.create("srv-r", "pre");
    expect(sync.pushes).toEqual([]);

    fs.writeFileSync(path.join(dataPath, "config.txt"), "v2");
    await snapshots.restore(created.id);

    expect(sync.pushes).toEqual(["srv-r"]);
    expect(fs.readFileSync(path.join(dataPath, "config.txt"), "utf8")).toBe("v1");
  });
});
