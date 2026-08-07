import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { nodes, servers as serversTable } from "../db/schema.js";
import type { AppConfig } from "../config.js";
import { LAB_DOCKER_SKILL, resolveFixturesRoot } from "../lab-games-root.js";
import { HealthService } from "./health.js";
import { NetToolsService } from "./net-tools.js";
import { ServerService } from "./servers.js";

const temps: Array<{ root: string; sqlite: Database.Database }> = [];

function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function tempConfig(): { db: ReturnType<typeof createDb>["db"]; config: AppConfig } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-health-"));
  const dbPath = path.join(root, "playon.sqlite");
  applyBootstrap(dbPath);
  const { db, sqlite } = createDb(dbPath);
  temps.push({ root, sqlite });
  const repoRoot = findRepoRoot(process.cwd());
  const config: AppConfig = {
    port: 0,
    dataRoot: root,
    dbPath,
    sessionSecret: "health-test-secret",
    llmMode: "openai_compatible",
    runtimeMode: "docker",
    skillsRoots: [
      resolveFixturesRoot(repoRoot),
      path.join(root, "skills"),
    ],
    advertiseHost: "127.0.0.1",
  };
  return { db, config };
}

afterEach(() => {
  while (temps.length) {
    const entry = temps.pop();
    if (!entry) break;
    try {
      entry.sqlite.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(entry.root, { recursive: true, force: true });
  }
});

describe("HealthService", () => {
  it("does not invent TCP :25565 for UDP-only or portless skills", async () => {
    const { db, config } = tempConfig();
    const skillDir = path.join(config.dataRoot!, "skills", "udp-only");
    fs.mkdirSync(path.join(skillDir, "guides"), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "metadata.yaml"),
      [
        "name: games.udp-only",
        "version: 0.1.0",
        "game: UDP Only",
        "description: udp",
        "containerSupport: none",
        "ports:",
        "  - name: game",
        "    protocol: udp",
        "    default: 16261",
        "healthChecks:",
        "  - id: process",
        "    type: process_running",
        "    onFail: restart",
        "dependencies: []",
        "requiredTools: []",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(skillDir, "guides", "INSTALL.md"), "# udp\n");
    config.skillsRoots = [path.join(config.dataRoot!, "skills"), ...config.skillsRoots];

    const servers = new ServerService(db, config);
    expect(servers.tcpGamePortForSkill("games.udp-only")).toBe(0);
    expect(servers.gamePortForSkill("games.udp-only")).toBe(16261);
    expect(servers.gamePortForSkill("drafts.missing")).toBe(0);

    const created = await servers.createFromSkill({
      skillName: "games.udp-only",
      serverName: "UDP Box",
    });
    const net = new NetToolsService(servers);
    const health = new HealthService(servers, net, config);
    const report = await health.checkServer(created.id);
    expect(report.checks.some((c) => c.id === "game-port")).toBe(false);
    expect(report.checks.every((c) => !String(c.detail).includes("25565"))).toBe(true);
  });

  it("resolves LAN joinHost for join/probe address", async () => {
    const { db, config } = tempConfig();
    const servers = new ServerService(db, config);
    await db.insert(nodes).values({
      id: "node-lan-1",
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

    const created = await servers.createFromSkill({
      skillName: LAB_DOCKER_SKILL,
      serverName: "LAN Paper",
    });
    await db
      .update(serversTable)
      .set({ nodeId: "node-lan-1" })
      .where(eq(serversTable.id, created.id));

    const row = await servers.get(created.id);
    expect(row).toBeTruthy();
    const addr = await servers.resolveJoinAddress(row!);
    expect(addr).toBe("172.16.0.109");
    const join = await servers.joinInfoFor(row!);
    expect(join.address).toBe("172.16.0.109");
  });

  it("reports process failure and remediates with restart", async () => {
    const { db, config } = tempConfig();
    const servers = new ServerService(db, config);
    const net = new NetToolsService(servers);
    const health = new HealthService(servers, net, config);

    const created = await servers.createFromSkill({
      skillName: LAB_DOCKER_SKILL,
      serverName: "Health Paper",
    });
    expect(created.status).toBe("stopped");

    const report = await health.checkServer(created.id, { remediate: true });
    expect(report.checks.some((c) => c.id === "process" && !c.ok)).toBe(true);
    const remediated = report.checks.some((c) => c.remediated === "restart");
    const restartAttempted = report.escalations.some((e) => e.startsWith("restart_failed:"));
    // Docker-capable hosts remediates to running; others still prove the restart path ran.
    expect(remediated || restartAttempted).toBe(true);
    if (remediated) {
      const after = await servers.get(created.id);
      expect(after?.status).toBe("running");
    }
  });
});
