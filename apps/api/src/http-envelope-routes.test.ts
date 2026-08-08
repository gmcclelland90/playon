import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { createDb, type Db } from "./db/client.js";
import { applyBootstrap } from "./db/migrate.js";
import { hashPassword } from "./auth/password.js";
import { createSession, SESSION_COOKIE } from "./auth/session.js";
import { servers, users } from "./db/schema.js";

type Envelope = { error: string; code?: string; details?: unknown };

/**
 * Routes migrated to the shared envelope in the W4b prove slice: session, servers
 * list/detail, and the stop mutation. Status codes and `error` text must match
 * pre-envelope behaviour; `code` is the addition.
 */
describe("transport error envelope on migrated routes", () => {
  let db: Db;
  let sqlite: Database.Database;
  let root: string;
  let cookie: string;
  let playerCookie: string;
  let config: AppConfig;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-http-envelope-"));
    const dbPath = path.join(root, "playon.sqlite");
    applyBootstrap(dbPath);
    const handle = createDb(dbPath);
    db = handle.db;
    sqlite = handle.sqlite;

    const skillsRoot = path.join(root, "skills");
    fs.mkdirSync(skillsRoot, { recursive: true });

    config = {
      port: 0,
      advertiseHost: "127.0.0.1",
      dataRoot: root,
      dbPath,
      sessionSecret: "test-session-secret-at-least-32-chars!!",
      skillsRoots: [skillsRoot],
      llmMode: "openai_compatible",
      runtimeMode: "native",
    };

    const now = new Date();
    await db.insert(users).values([
      {
        id: "owner-1",
        username: "owner",
        displayName: "Owner",
        passwordHash: hashPassword("password123"),
        role: "owner",
        createdAt: now,
      },
      {
        id: "player-1",
        username: "player",
        displayName: "Player",
        passwordHash: hashPassword("password123"),
        role: "player",
        createdAt: now,
      },
    ]);
    cookie = `${SESSION_COOKIE}=${await createSession(db, "owner-1")}`;
    playerCookie = `${SESSION_COOKIE}=${await createSession(db, "player-1")}`;

    await db.insert(servers).values({
      id: "srv-1",
      name: "Envelope Test",
      game: "Demo",
      nodeId: null,
      runtimeMode: "native",
      status: "stopped",
      dataPath: path.join(root, "servers", "srv-1"),
      createdAt: now,
    });
  });

  afterEach(() => {
    try {
      sqlite.close();
    } catch {
      // ignore
    }
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows may briefly lock WAL files
    }
  });

  it("answers 401 unauthorized on the session route", async () => {
    const app = createApp(db, config);
    const res = await app.request("/api/auth/me");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized", code: "unauthorized" });

    const ok = await app.request("/api/auth/me", { headers: { cookie } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { user: { username: string } }).user.username).toBe("owner");
  });

  it("answers 401 invalid_credentials on a bad login and 400 on a malformed body", async () => {
    const app = createApp(db, config);
    const bad = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "wrong-password" }),
    });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({
      error: "invalid_credentials",
      code: "invalid_credentials",
    });

    const malformed = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner" }),
    });
    expect(malformed.status).toBe(400);
    const body = (await malformed.json()) as Envelope;
    expect(body.code).toBe("invalid_request");
    expect(body.details).toBeDefined();
  });

  it("answers 409 already_setup once an owner exists", async () => {
    const app = createApp(db, config);
    const res = await app.request("/api/setup/owner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "second", password: "password123" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already_setup", code: "already_setup" });
  });

  it("keeps servers list/detail behaviour and adds codes", async () => {
    const app = createApp(db, config);

    const anon = await app.request("/api/servers");
    expect(anon.status).toBe(403);
    expect(await anon.json()).toEqual({ error: "forbidden", code: "forbidden" });

    const asPlayer = await app.request("/api/servers", { headers: { cookie: playerCookie } });
    expect(asPlayer.status).toBe(403);

    const list = await app.request("/api/servers", { headers: { cookie } });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { servers: Array<{ id: string }> };
    expect(listBody.servers.map((s) => s.id)).toEqual(["srv-1"]);

    const missing = await app.request("/api/servers/nope", { headers: { cookie } });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found", code: "server_not_found" });
  });

  it("keeps the stop mutation on 400 with a route code", async () => {
    const app = createApp(db, config);

    const anon = await app.request("/api/servers/srv-1/stop", { method: "POST" });
    expect(anon.status).toBe(403);
    expect(await anon.json()).toEqual({ error: "forbidden", code: "forbidden" });

    const res = await app.request("/api/servers/unknown/stop", {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe("server_stop_failed");
    expect(body.error).toMatch(/unknown_server/);
  });
});
