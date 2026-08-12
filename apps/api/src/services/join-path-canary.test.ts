import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  JOIN_PATH_CANARY_SKILL,
  probeJoinPath,
  wslSiblingNodeId,
} from "@playon/shared";
import { createDb } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { nodes, servers as serversTable } from "../db/schema.js";
import type { AppConfig } from "../config.js";
import { resolveFixturesRoot } from "../lab-games-root.js";
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-join-path-"));
  const dbPath = path.join(root, "playon.sqlite");
  applyBootstrap(dbPath);
  const { db, sqlite } = createDb(dbPath);
  temps.push({ root, sqlite });
  const repoRoot = findRepoRoot(process.cwd());
  const config: AppConfig = {
    port: 0,
    dataRoot: root,
    dbPath,
    sessionSecret: "join-path-test-secret",
    llmMode: "openai_compatible",
    runtimeMode: "docker",
    skillsRoots: [resolveFixturesRoot(repoRoot), path.join(root, "skills")],
    advertiseHost: "127.0.0.1",
  };
  return { db, config };
}

async function insertNode(
  db: ReturnType<typeof createDb>["db"],
  values: {
    id: string;
    name: string;
    os: string;
    kind?: string;
    joinHost?: string | null;
  },
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
    kind: values.kind ?? "lan",
    tunnelStatus: "none",
    joinHost: values.joinHost ?? null,
  });
}

async function listen(
  host: string,
  port = 0,
): Promise<{ server: net.Server; port: number }> {
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

describe("join-path canary (resolveJoinAddress topologies)", () => {
  it("Linux fixture on a LAN node publishes nodes.join_host, not 127.0.0.1", async () => {
    const { db, config } = tempConfig();
    const servers = new ServerService(db, config);
    await insertNode(db, {
      id: "lab-linux-1",
      name: "lab-linux",
      os: "linux",
      joinHost: "172.16.0.156",
    });

    const created = await servers.createFromSkill({
      skillName: JOIN_PATH_CANARY_SKILL,
      serverName: "Join Path Linux",
    });
    await db
      .update(serversTable)
      .set({ nodeId: "lab-linux-1" })
      .where(eq(serversTable.id, created.id));

    const row = await servers.get(created.id);
    expect(row).toBeTruthy();
    const join = await servers.joinInfoFor(row!);
    expect(join.address).toBe("172.16.0.156");
    expect(join.address).not.toBe("127.0.0.1");
    expect(join.port).toBe(25565);
  });

  it("WSL sibling walks to the parent Windows node's join_host (not WSL-internal)", async () => {
    const { db, config } = tempConfig();
    const servers = new ServerService(db, config);
    const winId = "playon-win-1";
    const wslId = wslSiblingNodeId(winId);
    await insertNode(db, {
      id: winId,
      name: "win",
      os: "windows",
      joinHost: "172.16.0.94",
    });
    await insertNode(db, {
      id: wslId,
      name: "win-wsl",
      os: "linux",
      joinHost: "172.22.144.1",
    });

    const created = await servers.createFromSkill({
      skillName: JOIN_PATH_CANARY_SKILL,
      serverName: "Join Path WSL",
    });
    await db
      .update(serversTable)
      .set({ nodeId: wslId })
      .where(eq(serversTable.id, created.id));

    const row = await servers.get(created.id);
    expect(row).toBeTruthy();
    const addr = await servers.resolveJoinAddress(row!);
    expect(addr).toBe("172.16.0.94");
    expect(addr).not.toBe("172.22.144.1");
    expect(addr).not.toBe("127.0.0.1");
  });

  it("Windows PE stand-in on playon-win-1 publishes that node's join_host", async () => {
    const { db, config } = tempConfig();
    const servers = new ServerService(db, config);
    await insertNode(db, {
      id: "playon-win-1",
      name: "win",
      os: "windows",
      joinHost: "172.16.0.94",
    });

    const created = await servers.createFromSkill({
      skillName: JOIN_PATH_CANARY_SKILL,
      serverName: "Join Path Win PE stand-in",
    });
    await db
      .update(serversTable)
      .set({ nodeId: "playon-win-1" })
      .where(eq(serversTable.id, created.id));

    const row = await servers.get(created.id);
    expect(row).toBeTruthy();
    const join = await servers.joinInfoFor(row!);
    expect(join.address).toBe("172.16.0.94");
    expect(join.port).toBe(25565);
  });
});

describe("join-path canary (TCP probe)", () => {
  it("fails when loopback accepts but the published join host does not", async () => {
    const { db, config } = tempConfig();
    const servers = new ServerService(db, config);
    const netTools = new NetToolsService(servers);
    const { server, port } = await listen("127.0.0.1");
    try {
      const result = await probeJoinPath({
        joinHost: "192.0.2.1",
        port,
        check: async (host, p) => {
          const probe = await netTools.portCheck({ host, port: p });
          return probe.state;
        },
      });
      expect(result.loopbackState).toBe("open");
      expect(result.joinHostState).toBe("closed");
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("loopback_open_join_host_closed");
    } finally {
      await closeServer(server);
    }
  });

  it("passes when a 0.0.0.0 bind is reachable on a non-loopback join host", async () => {
    const lan = firstNonLoopbackIPv4();
    if (!lan) return;

    const { db, config } = tempConfig();
    const servers = new ServerService(db, config);
    const netTools = new NetToolsService(servers);
    const { server, port } = await listen("0.0.0.0");
    try {
      const result = await probeJoinPath({
        joinHost: lan,
        port,
        check: async (host, p) => {
          const probe = await netTools.portCheck({ host, port: p });
          return probe.state;
        },
      });
      expect(result.ok).toBe(true);
      expect(result.reason).toBe("join_host_open");
      expect(result.joinHost).toBe(lan);
    } finally {
      await closeServer(server);
    }
  });
});

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
