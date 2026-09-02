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
import { nodes, users } from "../db/schema.js";
import { nodeRestartService, NodeRestartService } from "./node-restart.js";

describe("NodeRestartService", () => {
  it("hands the flag to exactly one heartbeat", () => {
    const svc = new NodeRestartService();
    expect(svc.consume("playon-win-1")).toBe(false);
    svc.request("playon-win-1", 1_000);
    expect(svc.isPending("playon-win-1")).toBe(true);
    expect(svc.requestedAt("playon-win-1")).toBe(1_000);
    expect(svc.consume("playon-win-1")).toBe(true);
    expect(svc.consume("playon-win-1")).toBe(false);
    expect(svc.isPending("playon-win-1")).toBe(false);
  });

  it("does not leak a flag from another node", () => {
    const svc = new NodeRestartService();
    svc.request("win-1");
    expect(svc.consume("win-2")).toBe(false);
    expect(svc.consume("win-1")).toBe(true);
  });
});

describe("POST /api/nodes/:id/restart", () => {
  let db: Db;
  let sqlite: Database.Database;
  let root: string;
  let cookie: string;

  function testConfig(): AppConfig {
    return {
      port: 0,
      advertiseHost: "127.0.0.1",
      dataRoot: root,
      dbPath: path.join(root, "playon.sqlite"),
      sessionSecret: "test-session-secret-at-least-32-chars!!",
      skillsRoots: [],
      llmMode: "openai_compatible",
      runtimeMode: "native",
      nodeToken: "restart-token",
    };
  }

  beforeEach(async () => {
    nodeRestartService.clear("playon-win-1");
    root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-restart-"));
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
    await db.insert(nodes).values({
      id: "playon-win-1",
      name: "playon-win-1",
      os: "windows",
      docker: false,
      native: true,
      steamcmd: false,
      agentVersion: "0.2.12",
      lastSeenAt: new Date(),
      kind: "lan",
      tunnelStatus: "none",
    });
  });

  afterEach(() => {
    nodeRestartService.clear("playon-win-1");
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

  it("flags the next heartbeat so the agent can exit without a job claim", async () => {
    const app = createApp(db, testConfig());
    const restart = await app.request("/api/nodes/playon-win-1/restart", {
      method: "POST",
      headers: { cookie },
    });
    expect(restart.status).toBe(200);
    expect(await restart.json()).toMatchObject({
      ok: true,
      nodeId: "playon-win-1",
      restartRequested: true,
    });

    const hb = await app.request("/api/nodes/heartbeat", {
      method: "POST",
      headers: { authorization: "Bearer restart-token", "content-type": "application/json" },
      body: JSON.stringify({
        nodeId: "playon-win-1",
        name: "playon-win-1",
        os: "windows",
        docker: false,
        native: true,
        steamcmd: false,
        agentVersion: "0.2.12",
      }),
    });
    expect(hb.status).toBe(200);
    expect(await hb.json()).toMatchObject({ ok: true, status: "online", restartRequested: true });

    const again = await app.request("/api/nodes/heartbeat", {
      method: "POST",
      headers: { authorization: "Bearer restart-token", "content-type": "application/json" },
      body: JSON.stringify({
        nodeId: "playon-win-1",
        name: "playon-win-1",
        os: "windows",
        docker: false,
        native: true,
        steamcmd: false,
        agentVersion: "0.2.12",
      }),
    });
    expect(await again.json()).toEqual({ ok: true, status: "online" });
  });
});
