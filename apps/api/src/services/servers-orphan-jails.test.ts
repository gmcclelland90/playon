import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { AppConfig } from "../config.js";
import { createDb, type Db } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { nodes, servers as serversTable } from "../db/schema.js";
import { LAB_DOCKER_SKILL, resolveFixturesRoot } from "../lab-games-root.js";
import { LAB_FIXTURE_MARKER_REL } from "@playon/shared";
import { eq } from "drizzle-orm";
import { nodeJobService } from "./node-jobs.js";
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

function tempEnv(): { db: Db; config: AppConfig; servers: ServerService; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-orphan-jail-"));
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
    skillsRoots: [resolveFixturesRoot(repoRoot), path.join(root, "skills")],
  };
  const { db, sqlite } = createDb(dbPath);
  temps.push({ root, sqlite });
  return { db, config, servers: new ServerService(db, config), root };
}

afterEach(() => {
  for (const entry of temps.splice(0)) {
    entry.sqlite.close();
    fs.rmSync(entry.root, { recursive: true, force: true });
  }
});

describe("server jail teardown + local orphan GC (#968)", () => {
  it("writes lab identity extras and removes the jail before dropping the row", async () => {
    const { servers, db } = tempEnv();
    const created = await servers.createFromSkill({
      skillName: LAB_DOCKER_SKILL,
      serverName: "lab-matrix-paper-test1",
    });
    const skill = JSON.parse(fs.readFileSync(path.join(created.dataPath, "skill.json"), "utf8")) as {
      serverName?: string;
      labFixture?: boolean;
    };
    expect(skill.serverName).toBe("lab-matrix-paper-test1");
    expect(skill.labFixture).toBe(true);
    expect(
      fs.readFileSync(path.join(created.dataPath, ...LAB_FIXTURE_MARKER_REL.split("/")), "utf8"),
    ).toMatch(/lab-matrix-paper-test1/);

    const removed = await servers.remove(created.id);
    expect(removed.id).toBe(created.id);
    expect(fs.existsSync(created.dataPath)).toBe(false);
    const rows = await db.select().from(serversTable).where(eq(serversTable.id, created.id));
    expect(rows).toHaveLength(0);
  });

  it("GC purges lab leftovers and keeps Frontier / unmarked jails", async () => {
    const { servers, root } = tempEnv();
    const live = await servers.createFromSkill({
      skillName: LAB_DOCKER_SKILL,
      serverName: "LAN MC",
    });
    const serversRoot = path.join(root, "servers");
    fs.mkdirSync(serversRoot, { recursive: true });

    const labId = "orphanLab1";
    const labPath = path.join(serversRoot, labId);
    fs.mkdirSync(path.join(labPath, "game"), { recursive: true });
    fs.mkdirSync(path.join(labPath, ".playon"), { recursive: true });
    fs.writeFileSync(
      path.join(labPath, "skill.json"),
      JSON.stringify({ serverName: "lab-matrix-foundry-aa", labFixture: true }),
    );
    fs.writeFileSync(path.join(labPath, ".playon", "lab-fixture"), "lab-matrix-foundry-aa\n");

    const frontierId = "orphanFrontier";
    const frontierPath = path.join(serversRoot, frontierId);
    fs.mkdirSync(path.join(frontierPath, "game"), { recursive: true });
    fs.writeFileSync(path.join(frontierPath, "skill.json"), JSON.stringify({ serverName: "Frontier" }));

    const unmarkedId = "orphanUnknown";
    fs.mkdirSync(path.join(serversRoot, unmarkedId, "game"), { recursive: true });

    const report = await servers.gcOrphanJails("local");
    expect(report.purged).toEqual([labId]);
    expect(fs.existsSync(labPath)).toBe(false);
    expect(fs.existsSync(frontierPath)).toBe(true);
    expect(fs.existsSync(path.join(serversRoot, unmarkedId))).toBe(true);
    expect(fs.existsSync(live.dataPath)).toBe(true);
    expect(report.kept.map((k) => k.id).sort()).toEqual([frontierId, unmarkedId].sort());
  });

  it("createFromSkill enqueues remote jail identity without waiting for the agent", async () => {
    const { servers, db } = tempEnv();
    await db.insert(nodes).values({
      id: "node-lan-gc",
      name: "lanbox",
      os: "linux",
      docker: true,
      native: true,
      steamcmd: true,
      freeDiskBytes: 1e11,
      lastSeenAt: new Date(),
      kind: "lan",
      tunnelStatus: "none",
      joinHost: "172.16.0.109",
    });
    const started = Date.now();
    const created = await servers.createFromSkill({
      skillName: LAB_DOCKER_SKILL,
      serverName: "lab-matrix-paper-sync",
      nodeId: "node-lan-gc",
    });
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(created.nodeId).toBe("node-lan-gc");
    const queued: string[] = [];
    for (;;) {
      const job = nodeJobService.claimNext("node-lan-gc");
      if (!job) break;
      queued.push(`${job.kind}:${String(job.args.path ?? "")}`);
    }
    expect(queued).toContain(`fs_write_text:servers/${created.id}/skill.json`);
    expect(queued).toContain(`fs_ensure_dir:servers/${created.id}/.playon`);
    expect(queued).toContain(`fs_write_text:servers/${created.id}/.playon/lab-fixture`);
  });
});
