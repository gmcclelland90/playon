import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { nodes, servers as serversTable } from "../db/schema.js";
import type { AppConfig } from "../config.js";
import { LAB_DOCKER_SKILL, resolveFixturesRoot } from "../lab-games-root.js";
import { HealthService } from "./health.js";
import { JoinReadyService } from "./join-ready.js";
import { NetToolsService } from "./net-tools.js";
import { ServerService, type ServerRecord } from "./servers.js";

/**
 * Health checks must not wrap `ServerService.get()`. That path reconciles
 * runtime status; an inserted LAN node with a fresh `lastSeenAt` is "online"
 * and remote `container_inspect` waits 15s for an agent that will never claim
 * the job. Two get()s in `checkServer` hit the 30s Vitest budget on Windows.
 */
function stubGet(servers: ServerService, row: ServerRecord): void {
  servers.get = async (id: string) => (id === row.id ? row : null);
}

function asRunning(row: ServerRecord, extras: Partial<ServerRecord> = {}): ServerRecord {
  return { ...row, status: "running", ...extras };
}

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
    expect(report.checks.some((c) => c.id === "host-ports")).toBe(true);
    expect(report.checks.every((c) => !String(c.detail).includes("25565"))).toBe(true);
  });

  it("alive process with advertised host ports unbound is not healthy", async () => {
    const { db, config } = tempConfig();
    const servers = new ServerService(db, config);
    const net = new NetToolsService(servers);
    const health = new HealthService(servers, net, config);

    const created = await servers.createFromSkill({
      skillName: LAB_DOCKER_SKILL,
      serverName: "Unbound Ports",
    });
    stubGet(servers, asRunning(created));
    servers.portsBoundOverride = async () => false;
    servers.portDeadGraceMs = 0;

    const report = await health.checkServer(created.id);
    expect(report.ok).toBe(false);
    expect(report.checks.some((c) => c.id === "host-ports" && !c.ok)).toBe(true);
    expect(report.checks.some((c) => c.id === "host-ports" && c.onFail === "restart")).toBe(
      true,
    );
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

    const row = { ...created, nodeId: "node-lan-1" };
    const addr = await servers.resolveJoinAddress(row);
    expect(addr).toBe("172.16.0.109");
    const join = await servers.joinInfoFor(row);
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

    // Unit bar must not wait on a live Docker Paper start (hangs/times out under CI load).
    // Return a synthetic running record; do not persist "running" then call get() —
    // reconcileStatus would see a missing container and flip the row back to stopped.
    const restart = vi.spyOn(servers, "restart").mockResolvedValue({
      ...created,
      status: "running",
    });

    const report = await health.checkServer(created.id, { remediate: true });
    expect(report.checks.some((c) => c.id === "process" && !c.ok)).toBe(true);
    expect(restart).toHaveBeenCalledWith(created.id);
    expect(report.checks.some((c) => c.remediated === "restart")).toBe(true);
    expect(report.escalations.some((e) => e.startsWith("restart_failed:"))).toBe(false);
    restart.mockRestore();
  });

  it("records restart_failed when remediation restart throws", async () => {
    const { db, config } = tempConfig();
    const servers = new ServerService(db, config);
    const net = new NetToolsService(servers);
    const health = new HealthService(servers, net, config);

    const created = await servers.createFromSkill({
      skillName: LAB_DOCKER_SKILL,
      serverName: "Health Paper Fail",
    });
    expect(created.status).toBe("stopped");

    const restart = vi.spyOn(servers, "restart").mockRejectedValue(new Error("docker_unavailable"));
    const report = await health.checkServer(created.id, { remediate: true });
    expect(report.checks.some((c) => c.id === "process" && !c.ok)).toBe(true);
    expect(restart).toHaveBeenCalledWith(created.id);
    expect(report.escalations.some((e) => e === "restart_failed:docker_unavailable")).toBe(true);
    expect(report.checks.every((c) => c.remediated !== "restart")).toBe(true);
    restart.mockRestore();
  });

  it("join-path gate: localhost-open + advertised-closed is not ready and does not restart", async () => {
    const lan = "172.16.0.94";
    const { db, config } = tempConfig();
    const servers = new ServerService(db, config);
    const net = new NetToolsService(servers);
    vi.spyOn(net, "portCheck").mockImplementation(async ({ host, port }) => ({
      host: host?.trim() || "127.0.0.1",
      port,
      state: host === lan ? "closed" : "open",
    }));
    const joinReady = new JoinReadyService(servers, net, config, undefined, async () => ({
      state: "open",
      scope: "node",
      unavailable: false,
    }));
    const health = new HealthService(servers, net, config, undefined, joinReady);

    await db.insert(nodes).values({
      id: "node-lan-split",
      name: "lan",
      os: "linux",
      docker: true,
      native: true,
      steamcmd: true,
      freeDiskBytes: 1e11,
      lastSeenAt: new Date(),
      kind: "lan",
      tunnelStatus: "none",
      joinHost: lan,
    });
    const created = await servers.createFromSkill({
      skillName: LAB_DOCKER_SKILL,
      serverName: "Health Join Split",
    });
    stubGet(servers, asRunning(created, { nodeId: "node-lan-split" }));
    // Host bind is up; advertised join host is closed — publish gap, not dead.
    servers.portsBoundOverride = async () => true;
    servers.joinInfoFor = async () => ({ address: lan, port: 25565 });
    servers.resolveJoinAddress = async () => lan;
    const restart = vi.spyOn(servers, "restart");

    const report = await health.checkServer(created.id, { remediate: true });
    expect(report.ready).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.checks.some((c) => c.id === "join-path" && !c.ok)).toBe(true);
    expect(report.joinPath?.reason).toBe("loopback_open_join_host_closed");
    expect(restart).not.toHaveBeenCalled();
  });

  it("does not treat Home soak 127.0.0.1 as the remote server's loopback", async () => {
    const lan = "172.16.0.94";
    const { db, config } = tempConfig();
    const servers = new ServerService(db, config);
    const net = new NetToolsService(servers);
    vi.spyOn(net, "portCheck").mockImplementation(async ({ host, port }) => ({
      host: host?.trim() || "127.0.0.1",
      port,
      state: host === lan ? "closed" : "open",
    }));
    const joinReady = new JoinReadyService(servers, net, config);
    const health = new HealthService(servers, net, config, undefined, joinReady);

    await db.insert(nodes).values({
      id: "playon-win-1-wsl",
      name: "wsl",
      os: "linux",
      docker: true,
      native: true,
      steamcmd: true,
      freeDiskBytes: 1e11,
      lastSeenAt: new Date(),
      kind: "lan",
      tunnelStatus: "none",
      joinHost: null,
    });
    const created = await servers.createFromSkill({
      skillName: LAB_DOCKER_SKILL,
      serverName: "Health Soak Split",
    });
    stubGet(servers, asRunning(created, { nodeId: "playon-win-1-wsl" }));
    servers.portsBoundOverride = async () => true;
    servers.joinInfoFor = async () => ({ address: lan, port: 25565 });
    servers.resolveJoinAddress = async () => lan;
    const restart = vi.spyOn(servers, "restart");

    const report = await health.checkServer(created.id, { remediate: true });
    expect(report.ready).toBe(false);
    expect(report.joinPath?.reason).toBe("join_host_closed");
    expect(report.joinPath?.loopbackState).toBe("closed");
    expect(report.joinPath?.loopbackScope).toBe("node");
    expect(restart).not.toHaveBeenCalled();
  });
});
