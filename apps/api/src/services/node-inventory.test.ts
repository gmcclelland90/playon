import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { AppConfig } from "../config.js";
import { createDb, type Db } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { hashPassword } from "../auth/password.js";
import { createSession, SESSION_COOKIE } from "../auth/session.js";
import { servers, users } from "../db/schema.js";
import {
  clearNodeContainers,
  forgetNodeContainers,
  nodeContainers,
  nodeProcesses,
  recordNodeContainers,
  recordNodeProcesses,
  serverUsageFromInventory,
} from "./node-inventory.js";

describe("node-inventory", () => {
  beforeEach(() => {
    clearNodeContainers();
  });

  it("stores a heartbeat inventory and ignores omitted fields from older agents", () => {
    recordNodeContainers("playon-win-1", [
      { name: "lab-sbox", image: "har0x/sbox-server:public", status: "running" },
    ]);
    expect(nodeContainers("playon-win-1")[0]?.name).toBe("lab-sbox");
    recordNodeContainers("playon-win-1", undefined);
    expect(nodeContainers("playon-win-1")[0]?.name).toBe("lab-sbox");
    recordNodeContainers("playon-win-1", []);
    expect(nodeContainers("playon-win-1")).toEqual([]);
  });

  it("forgets a node without touching others", () => {
    recordNodeContainers("playon-win-1", [
      { name: "lab-sbox", image: "har0x/sbox-server:public", status: "running" },
    ]);
    recordNodeContainers("playon-win-1-wsl", [
      { name: "lab-matrix-paper", image: "itzg/minecraft-server", status: "running" },
    ]);
    forgetNodeContainers("playon-win-1");
    expect(nodeContainers("playon-win-1")).toEqual([]);
    expect(nodeContainers("playon-win-1-wsl")[0]?.name).toBe("lab-matrix-paper");
  });

  it("matches managed server usage from container or process inventory", () => {
    recordNodeContainers("node-a", [
      {
        name: "playon-abc",
        image: "itzg/minecraft-server",
        status: "running",
        cpuPercent: 11,
        memUsedBytes: 400_000_000,
      },
    ]);
    recordNodeProcesses("node-a", [
      { name: "server-z", status: "running", cpuPercent: 22, memUsedBytes: 800_000_000 },
    ]);
    expect(serverUsageFromInventory("abc", "node-a", "docker")).toEqual({
      cpuPercent: 11,
      memUsedBytes: 400_000_000,
    });
    expect(serverUsageFromInventory("z", "node-a", "native")).toEqual({
      cpuPercent: 22,
      memUsedBytes: 800_000_000,
    });
    expect(nodeProcesses("node-a")[0]?.name).toBe("server-z");
  });
});

describe("GET /api/nodes container inventory", () => {
  let db: Db;
  let sqlite: Database.Database;
  let root: string;
  let cookie: string;

  beforeEach(async () => {
    clearNodeContainers();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-inv-"));
    const dbPath = path.join(root, "playon.sqlite");
    applyBootstrap(dbPath);
    const handle = createDb(dbPath);
    db = handle.db;
    sqlite = handle.sqlite;
    await db.insert(users).values({
      id: "owner-1",
      username: "owner",
      displayName: "Owner",
      passwordHash: hashPassword("password123"),
      role: "owner",
      createdAt: new Date(),
    });
    cookie = `${SESSION_COOKIE}=${await createSession(db, "owner-1")}`;
  });

  afterEach(() => {
    clearNodeContainers();
    try {
      sqlite.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("echoes a Windows-engine container from heartbeat onto the node board", async () => {
    const config: AppConfig = {
      port: 0,
      advertiseHost: "127.0.0.1",
      dataRoot: root,
      dbPath: path.join(root, "playon.sqlite"),
      sessionSecret: "test-session-secret-at-least-32-chars!!",
      skillsRoots: [],
      llmMode: "openai_compatible",
      runtimeMode: "native",
      nodeToken: "inv-token",
    };
    const app = createApp(db, config);
    const hb = await app.request("/api/nodes/heartbeat", {
      method: "POST",
      headers: { authorization: "Bearer inv-token", "content-type": "application/json" },
      body: JSON.stringify({
        nodeId: "playon-win-1",
        name: "playon-win-1",
        os: "windows",
        docker: true,
        native: true,
        steamcmd: false,
        agentVersion: "0.2.9",
        cpuPercent: 18,
        memUsedBytes: 6_000_000_000,
        memTotalBytes: 16_000_000_000,
        containers: [
          {
            name: "lab-sbox",
            image: "har0x/sbox-server:public",
            status: "running",
            ports: [{ host: 27150, container: 27150, protocol: "tcp" }],
            cpuPercent: 9,
            memUsedBytes: 1_200_000_000,
          },
        ],
      }),
    });
    expect(hb.status).toBe(200);

    const list = await app.request("/api/nodes", { headers: { cookie } });
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      nodes: Array<{
        id: string;
        cpuPercent?: number | null;
        memUsedBytes?: number | null;
        memTotalBytes?: number | null;
        containers?: Array<{ name: string; image: string; cpuPercent?: number }>;
      }>;
    };
    const win = body.nodes.find((n) => n.id === "playon-win-1");
    expect(win?.cpuPercent).toBe(18);
    expect(win?.memUsedBytes).toBe(6_000_000_000);
    expect(win?.memTotalBytes).toBe(16_000_000_000);
    expect(win?.containers).toEqual([
      {
        name: "lab-sbox",
        image: "har0x/sbox-server:public",
        status: "running",
        ports: [{ host: 27150, container: 27150, protocol: "tcp" }],
        cpuPercent: 9,
        memUsedBytes: 1_200_000_000,
      },
    ]);
  });

  it("attaches per-server usage from heartbeat inventory onto GET /api/servers", async () => {
    const config: AppConfig = {
      port: 0,
      advertiseHost: "127.0.0.1",
      dataRoot: root,
      dbPath: path.join(root, "playon.sqlite"),
      sessionSecret: "test-session-secret-at-least-32-chars!!",
      skillsRoots: [],
      llmMode: "openai_compatible",
      runtimeMode: "native",
      nodeToken: "inv-token",
    };
    const app = createApp(db, config);
    const hb = await app.request("/api/nodes/heartbeat", {
      method: "POST",
      headers: { authorization: "Bearer inv-token", "content-type": "application/json" },
      body: JSON.stringify({
        nodeId: "node-a",
        name: "node-a",
        os: "linux",
        docker: true,
        native: true,
        steamcmd: false,
        agentVersion: "0.2.12",
        containers: [
          {
            name: "playon-abc",
            image: "itzg/minecraft-server",
            status: "running",
            cpuPercent: 15,
            memUsedBytes: 700_000_000,
          },
        ],
      }),
    });
    expect(hb.status).toBe(200);
    await db.insert(servers).values({
      id: "abc",
      name: "Paper",
      game: "paper",
      nodeId: "node-a",
      runtimeMode: "docker",
      status: "running",
      dataPath: path.join(root, "servers", "abc"),
      createdAt: new Date(),
    });
    const list = await app.request("/api/servers", { headers: { cookie } });
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      servers: Array<{ id: string; cpuPercent?: number; memUsedBytes?: number }>;
    };
    const paper = body.servers.find((s) => s.id === "abc");
    expect(paper).toMatchObject({ cpuPercent: 15, memUsedBytes: 700_000_000 });
    expect(Array.isArray((paper as { usageHistory?: unknown }).usageHistory)).toBe(true);
  });

  it("stores a short usage ring and surfaces a disk_low alert on GET /api/nodes", async () => {
    const config: AppConfig = {
      port: 0,
      advertiseHost: "127.0.0.1",
      dataRoot: root,
      dbPath: path.join(root, "playon.sqlite"),
      sessionSecret: "test-session-secret-at-least-32-chars!!",
      skillsRoots: [],
      llmMode: "openai_compatible",
      runtimeMode: "native",
      nodeToken: "inv-token",
    };
    const app = createApp(db, config);
    await db.insert(servers).values({
      id: "mc",
      name: "Small Minecraft",
      game: "paper",
      nodeId: "playon-dev",
      runtimeMode: "docker",
      status: "running",
      dataPath: path.join(root, "servers", "mc"),
      createdAt: new Date(),
    });
    for (const cpu of [5.9, 6.1]) {
      const hb = await app.request("/api/nodes/heartbeat", {
        method: "POST",
        headers: { authorization: "Bearer inv-token", "content-type": "application/json" },
        body: JSON.stringify({
          nodeId: "playon-dev",
          name: "playon-dev",
          os: "linux",
          docker: true,
          native: true,
          steamcmd: false,
          agentVersion: "0.2.12",
          cpuPercent: cpu,
          memUsedBytes: 5.2 * 1024 ** 3,
          memTotalBytes: 62.5 * 1024 ** 3,
          freeDiskBytes: 400 * 1024 * 1024,
          containers: [
            {
              name: "playon-mc",
              image: "itzg/minecraft-server",
              status: "running",
              cpuPercent: 1.5,
              memUsedBytes: 1.5 * 1024 ** 3,
            },
          ],
        }),
      });
      expect(hb.status).toBe(200);
    }
    const nodesRes = await app.request("/api/nodes", { headers: { cookie } });
    expect(nodesRes.status).toBe(200);
    const nodesBody = (await nodesRes.json()) as {
      nodes: Array<{
        id: string;
        usageHistory: Array<{ cpuPercent?: number; freeDiskBytes?: number }>;
        alerts: Array<{ kind: string; tone: string; message: string }>;
      }>;
    };
    const dev = nodesBody.nodes.find((n) => n.id === "playon-dev");
    expect(dev?.usageHistory.length).toBe(2);
    expect(dev?.usageHistory[1]?.cpuPercent).toBe(6.1);
    expect(dev?.alerts.some((a) => a.kind === "disk_low" && a.tone === "danger")).toBe(true);

    const serversRes = await app.request("/api/servers", { headers: { cookie } });
    const serversBody = (await serversRes.json()) as {
      servers: Array<{ id: string; usageHistory?: Array<{ cpuPercent?: number }> }>;
    };
    const mc = serversBody.servers.find((s) => s.id === "mc");
    expect(mc?.usageHistory?.length).toBe(2);
    expect(mc?.usageHistory?.[1]?.cpuPercent).toBe(1.5);
  });
});
