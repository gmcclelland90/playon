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
import { users } from "../db/schema.js";
import {
  clearNodeContainers,
  forgetNodeContainers,
  nodeContainers,
  recordNodeContainers,
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
        containers: [
          {
            name: "lab-sbox",
            image: "har0x/sbox-server:public",
            status: "running",
            ports: [{ host: 27150, container: 27150, protocol: "tcp" }],
          },
        ],
      }),
    });
    expect(hb.status).toBe(200);

    const list = await app.request("/api/nodes", { headers: { cookie } });
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      nodes: Array<{ id: string; containers?: Array<{ name: string; image: string }> }>;
    };
    const win = body.nodes.find((n) => n.id === "playon-win-1");
    expect(win?.containers).toEqual([
      {
        name: "lab-sbox",
        image: "har0x/sbox-server:public",
        status: "running",
        ports: [{ host: 27150, container: 27150, protocol: "tcp" }],
      },
    ]);
  });
});
