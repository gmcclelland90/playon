import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { JOIN_PATH_CANARY_SKILL, playerPanelStatusFromJoinReady } from "@playon/shared";
import type { LiveServerState } from "@playon/shared";
import { createDb } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { nodes, servers as serversTable } from "../db/schema.js";
import type { AppConfig } from "../config.js";
import { resolveFixturesRoot } from "../lab-games-root.js";
import { JoinReadyService } from "./join-ready.js";
import { NetToolsService } from "./net-tools.js";
import type { ServerQueryService } from "./server-query.js";
import { ServerService } from "./servers.js";
import { writeSkillMarker } from "./skill-marker.js";

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

function tempConfig(): { db: ReturnType<typeof createDb>["db"]; config: AppConfig; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-join-ready-"));
  const dbPath = path.join(root, "playon.sqlite");
  applyBootstrap(dbPath);
  const { db, sqlite } = createDb(dbPath);
  temps.push({ root, sqlite });
  const repoRoot = findRepoRoot(process.cwd());
  const config: AppConfig = {
    port: 0,
    dataRoot: root,
    dbPath,
    sessionSecret: "join-ready-test-secret",
    llmMode: "openai_compatible",
    runtimeMode: "docker",
    skillsRoots: [resolveFixturesRoot(repoRoot), path.join(root, "skills")],
    advertiseHost: "127.0.0.1",
  };
  return { db, config, root };
}

async function insertNode(
  db: ReturnType<typeof createDb>["db"],
  values: { id: string; name: string; os: string; joinHost?: string | null },
) {
  await db.insert(nodes).values({
    id: values.id,
    name: values.name,
    os: values.os,
    docker: true,
    native: true,
    steamcmd: true,
    freeDiskBytes: 1e11,
    lastSeenAt: new Date(),
    kind: "lan",
    tunnelStatus: "none",
    joinHost: values.joinHost ?? null,
  });
}

async function seedRunningServer(
  db: ReturnType<typeof createDb>["db"],
  root: string,
  nodeId: string,
): Promise<{ id: string; dataPath: string }> {
  const id = "srv-join-ready";
  const dataPath = path.join(root, "servers", id);
  writeSkillMarker(dataPath, {
    skillName: JOIN_PATH_CANARY_SKILL,
    version: "0.1.0",
    runtimeMode: "docker",
    containerSupport: "full",
    queryDialect: "none",
    nodeId,
  });
  await db.insert(serversTable).values({
    id,
    name: "Join Ready",
    game: "Lab Docker Server",
    nodeId,
    runtimeMode: "docker",
    status: "running",
    dataPath,
    createdAt: new Date(),
  });
  return { id, dataPath };
}

async function listen(host: string, port = 0): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("listen_failed");
  }
  return { server, port: address.port };
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function firstNonLoopbackIPv4(): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const e of entries ?? []) {
      const family = String(e.family);
      if (e.internal || (family !== "IPv4" && family !== "4")) continue;
      if (e.address) return e.address;
    }
  }
  return null;
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

describe("JoinReadyService", () => {
  it("Home soak localhost-open does not count as node loopback for a remote server", async () => {
    const lan = firstNonLoopbackIPv4();
    if (!lan) return;

    const { db, config, root } = tempConfig();
    const servers = new ServerService(db, config);
    const net = new NetToolsService(servers);
    const joinReady = new JoinReadyService(servers, net, config);

    await insertNode(db, { id: "node-lan", name: "lan", os: "linux", joinHost: lan });
    const seeded = await seedRunningServer(db, root, "node-lan");
    const { server, port } = await listen("127.0.0.1");
    try {
      servers.get = async (id: string) =>
        id === seeded.id
          ? {
              id: seeded.id,
              name: "Join Ready",
              game: "Lab Docker Server",
              nodeId: "node-lan",
              runtimeMode: "docker",
              status: "running",
              dataPath: seeded.dataPath,
              createdAt: new Date(),
            }
          : null;
      servers.joinInfoFor = async () => ({ address: lan, port });

      const report = await joinReady.probe(seeded.id);
      expect(report.ready).toBe(false);
      expect(report.status).toBe("degraded");
      expect(report.reason).toBe("join_host_closed");
      expect(report.joinPath.joinHost).toBe(lan);
      expect(report.joinPath.loopbackState).toBe("closed");
      expect(report.joinPath.joinHostState).toBe("closed");
      expect(report.joinPath.loopbackScope).toBe("node");
    } finally {
      await closeServer(server);
    }
  });

  it("node loopback-open + advertised-closed is not ready", async () => {
    const lan = firstNonLoopbackIPv4();
    if (!lan) return;

    const { db, config, root } = tempConfig();
    const servers = new ServerService(db, config);
    const net = new NetToolsService(servers);
    const joinReady = new JoinReadyService(servers, net, config, undefined, async () => ({
      state: "open",
      scope: "node",
      unavailable: false,
    }));

    await insertNode(db, { id: "node-lan", name: "lan", os: "linux", joinHost: lan });
    const seeded = await seedRunningServer(db, root, "node-lan");
    const { server, port } = await listen("127.0.0.1");
    try {
      servers.get = async (id: string) =>
        id === seeded.id
          ? {
              id: seeded.id,
              name: "Join Ready",
              game: "Lab Docker Server",
              nodeId: "node-lan",
              runtimeMode: "docker",
              status: "running",
              dataPath: seeded.dataPath,
              createdAt: new Date(),
            }
          : null;
      servers.joinInfoFor = async () => ({ address: lan, port });

      const report = await joinReady.probe(seeded.id);
      expect(report.ready).toBe(false);
      expect(report.status).toBe("degraded");
      expect(report.reason).toBe("loopback_open_join_host_closed");
      expect(report.joinPath.joinHost).toBe(lan);
      expect(report.joinPath.loopbackState).toBe("open");
      expect(report.joinPath.joinHostState).toBe("closed");
      expect(report.joinPath.loopbackScope).toBe("node");
    } finally {
      await closeServer(server);
    }
  });

  it("UDP-only + host-ports bound is not canary-ready but player status is running", async () => {
    const { db, config, root } = tempConfig();
    const skillDir = path.join(root, "skills", "udp-only");
    fs.mkdirSync(path.join(skillDir, "guides"), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "metadata.yaml"),
      [
        "name: fixtures.udp-only",
        "version: 0.1.0",
        "game: UDP Only",
        "description: udp fixture",
        "containerSupport: none",
        "queryDialect: none",
        "ports:",
        "  - name: game",
        "    protocol: udp",
        "    default: 16261",
        "dependencies: []",
        "requiredTools: []",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(skillDir, "guides", "INSTALL.md"), "# udp\n");
    config.skillsRoots = [path.join(root, "skills"), ...config.skillsRoots];

    const servers = new ServerService(db, config);
    const net = new NetToolsService(servers);
    const joinReady = new JoinReadyService(servers, net, config);
    servers.portsBoundOverride = async () => true;

    await insertNode(db, { id: "local", name: "local", os: "linux" });
    const id = "srv-udp-only";
    const dataPath = path.join(root, "servers", id);
    writeSkillMarker(dataPath, {
      skillName: "fixtures.udp-only",
      version: "0.1.0",
      runtimeMode: "native",
      containerSupport: "none",
      queryDialect: "none",
      nodeId: "local",
    });
    await db.insert(serversTable).values({
      id,
      name: "UDP Only",
      game: "UDP Only",
      nodeId: "local",
      runtimeMode: "native",
      status: "running",
      dataPath,
      createdAt: new Date(),
    });
    servers.get = async (serverId: string) =>
      serverId === id
        ? {
            id,
            name: "UDP Only",
            game: "UDP Only",
            nodeId: "local",
            runtimeMode: "native",
            status: "running",
            dataPath,
            createdAt: new Date(),
          }
        : null;
    servers.joinInfoFor = async () => ({ address: "172.16.0.109", port: 16261 });

    const report = await joinReady.probe(id);
    expect(report.protocol).toBe("udp");
    expect(report.ready).toBe(false);
    expect(report.reason).toBe("udp_join_unproven");
    expect(report.joinPath.reason).toBe("udp_not_tcp_probed");
    expect(report.hostPortsBound).toBe(true);
    expect(report.status).toBe("running");
    expect(playerPanelStatusFromJoinReady(report, "running")).toBe("running");
  });

  it("advertised-open is ready", async () => {
    const lan = firstNonLoopbackIPv4();
    if (!lan) return;

    const { db, config, root } = tempConfig();
    const servers = new ServerService(db, config);
    const net = new NetToolsService(servers);
    const joinReady = new JoinReadyService(servers, net, config);

    await insertNode(db, { id: "node-lan", name: "lan", os: "linux", joinHost: lan });
    const seeded = await seedRunningServer(db, root, "node-lan");
    const { server, port } = await listen("0.0.0.0");
    try {
      servers.get = async (id: string) =>
        id === seeded.id
          ? {
              id: seeded.id,
              name: "Join Ready",
              game: "Lab Docker Server",
              nodeId: "node-lan",
              runtimeMode: "docker",
              status: "running",
              dataPath: seeded.dataPath,
              createdAt: new Date(),
            }
          : null;
      servers.joinInfoFor = async () => ({ address: lan, port });

      const report = await joinReady.probe(seeded.id);
      expect(report.ready).toBe(true);
      expect(report.status).toBe("running");
      expect(report.reason).toBe("join_host_open");
      expect(report.joinPath.joinHost).toBe(lan);
    } finally {
      await closeServer(server);
    }
  });

  async function seedPzUdp(args: {
    db: ReturnType<typeof createDb>["db"];
    config: AppConfig;
    root: string;
    queryDialect: "none" | "project_zomboid";
    queries?: ServerQueryService;
  }) {
    const skillDir = path.join(args.root, "skills", "games", "project-zomboid");
    fs.mkdirSync(path.join(skillDir, "guides"), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "metadata.yaml"),
      [
        "name: games.project-zomboid",
        "version: 0.1.0",
        "game: Project Zomboid",
        "containerSupport: none",
        `queryDialect: ${args.queryDialect}`,
        "ports:",
        "  - name: game",
        "    protocol: udp",
        "    default: 16261",
        "healthChecks: []",
        "dependencies: []",
        "requiredTools: []",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(skillDir, "guides", "INSTALL.md"), "# PZ\n");
    args.config.skillsRoots = [path.join(args.root, "skills"), ...args.config.skillsRoots];

    const servers = new ServerService(args.db, args.config);
    const net = new NetToolsService(servers);
    const joinReady = new JoinReadyService(servers, net, args.config, args.queries);
    servers.portsBoundOverride = async () => true;

    await insertNode(args.db, { id: "local", name: "home", os: "linux" });
    const id = "srv-pz-query";
    const dataPath = path.join(args.root, "servers", id);
    writeSkillMarker(dataPath, {
      skillName: "games.project-zomboid",
      version: "0.1.0",
      runtimeMode: "native",
      containerSupport: "none",
      queryDialect: args.queryDialect,
      nodeId: "local",
    });
    await args.db.insert(serversTable).values({
      id,
      name: "PZ Lab",
      game: "Project Zomboid",
      nodeId: "local",
      runtimeMode: "native",
      status: "running",
      dataPath,
      createdAt: new Date(),
    });
    servers.get = async (sid: string) =>
      sid === id
        ? {
            id,
            name: "PZ Lab",
            game: "Project Zomboid",
            nodeId: "local",
            runtimeMode: "native",
            status: "running",
            dataPath,
            createdAt: new Date(),
          }
        : null;
    servers.joinInfoFor = async () => ({ address: "127.0.0.1", port: 16261 });
    servers.gamePortProtocolForSkill = () => "udp";
    return { joinReady, id };
  }

  it("uses query_online as extra UDP proof when the PZ dialect answers", async () => {
    const { db, config, root } = tempConfig();
    const queries = {
      queryServer: async () =>
        ({
          online: true,
          players: 64,
          maxPlayers: 80,
          game: "Project Zomboid",
        }) satisfies LiveServerState,
    } as Pick<ServerQueryService, "queryServer"> as ServerQueryService;
    const { joinReady, id } = await seedPzUdp({
      db,
      config,
      root,
      queryDialect: "project_zomboid",
      queries,
    });

    const report = await joinReady.probe(id);
    expect(report.ready).toBe(true);
    expect(report.reason).toBe("query_online");
    expect(report.protocol).toBe("udp");
    expect(report.queryOnline).toBe(true);
  });

  it("does not force query_offline over udp_join_unproven when PZ query fails", async () => {
    const { db, config, root } = tempConfig();
    let queried = 0;
    const queries = {
      queryServer: async () => {
        queried += 1;
        return { online: false, error: "pz_query_failed" } satisfies LiveServerState;
      },
    } as Pick<ServerQueryService, "queryServer"> as ServerQueryService;
    const { joinReady, id } = await seedPzUdp({
      db,
      config,
      root,
      queryDialect: "project_zomboid",
      queries,
    });

    const report = await joinReady.probe(id);
    expect(queried).toBe(1);
    expect(report.ready).toBe(false);
    expect(report.reason).toBe("udp_join_unproven");
    expect(report.reason).not.toBe("query_offline");
    expect(report.queryOnline).toBeNull();
    expect(report.hostPortsBound).toBe(true);
    expect(playerPanelStatusFromJoinReady(report, "running")).toBe("running");
  });

  it("does not treat catalog queryDialect none as wantsQuery for games.project-zomboid", async () => {
    const { db, config, root } = tempConfig();
    let queried = 0;
    const queries = {
      queryServer: async () => {
        queried += 1;
        return { online: false, error: "should_not_run" } satisfies LiveServerState;
      },
    } as Pick<ServerQueryService, "queryServer"> as ServerQueryService;
    const { joinReady, id } = await seedPzUdp({
      db,
      config,
      root,
      queryDialect: "none",
      queries,
    });

    const report = await joinReady.probe(id);
    expect(queried).toBe(0);
    expect(report.reason).toBe("udp_join_unproven");
    expect(report.queryOnline).toBeNull();
  });
});
