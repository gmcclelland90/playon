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
 * Routes migrated to the shared envelope: session, servers list/detail, and every
 * mutating server route (create, import, start, stop, restart, delete, relocate,
 * console). Status codes and `error` text must match pre-envelope behaviour;
 * `code` is the addition.
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

  it("gates every mutating server route on the same 403 forbidden envelope", async () => {
    const app = createApp(db, config);
    const forbidden = { error: "forbidden", code: "forbidden" };
    const attempts: Array<[string, RequestInit]> = [
      ["/api/servers", { method: "POST" }],
      ["/api/servers/import", { method: "POST" }],
      ["/api/servers/import/sftp", { method: "POST" }],
      ["/api/servers/srv-1/start", { method: "POST" }],
      ["/api/servers/srv-1/restart", { method: "POST" }],
      ["/api/servers/srv-1/relocate", { method: "POST" }],
      ["/api/servers/srv-1/console", { method: "POST" }],
      ["/api/servers/srv-1", { method: "DELETE" }],
    ];

    for (const [path_, init] of attempts) {
      const anon = await app.request(path_, init);
      expect([path_, anon.status]).toEqual([path_, 403]);
      expect(await anon.json()).toEqual(forbidden);

      const asPlayer = await app.request(path_, {
        ...init,
        headers: { cookie: playerCookie },
      });
      expect([path_, asPlayer.status]).toEqual([path_, 403]);
      expect(await asPlayer.json()).toEqual(forbidden);
    }
  });

  it("keeps start/restart on 400 with per-route codes", async () => {
    const app = createApp(db, config);

    const start = await app.request("/api/servers/unknown/start", {
      method: "POST",
      headers: { cookie },
    });
    expect(start.status).toBe(400);
    const startBody = (await start.json()) as Envelope;
    expect(startBody.code).toBe("server_start_failed");
    expect(startBody.error).toMatch(/unknown_server/);

    const restart = await app.request("/api/servers/unknown/restart", {
      method: "POST",
      headers: { cookie },
    });
    expect(restart.status).toBe(400);
    const restartBody = (await restart.json()) as Envelope;
    expect(restartBody.code).toBe("server_restart_failed");
    expect(restartBody.error).toMatch(/unknown_server/);
  });

  it("keeps delete and relocate promoting unknown ids to 404", async () => {
    const app = createApp(db, config);

    const removed = await app.request("/api/servers/unknown", {
      method: "DELETE",
      headers: { cookie },
    });
    expect(removed.status).toBe(404);
    const removedBody = (await removed.json()) as Envelope;
    expect(removedBody.code).toBe("server_delete_failed");
    expect(removedBody.error).toMatch(/unknown_server/);

    const relocated = await app.request("/api/servers/unknown/relocate", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ targetNodeId: "node-a" }),
    });
    expect(relocated.status).toBe(404);
    const relocatedBody = (await relocated.json()) as Envelope;
    expect(relocatedBody.code).toBe("server_relocate_failed");
    expect(relocatedBody.error).toMatch(/unknown_server/);
  });

  it("renders request-contract failures as 400 invalid_request with issues", async () => {
    const app = createApp(db, config);
    const cases: Array<[string, unknown, string]> = [
      ["/api/servers", {}, "skillName_required"],
      ["/api/servers/import", { serverName: "No source" }, "sourcePath"],
      ["/api/servers/import/sftp", { host: "h", remotePath: "/x" }, "username"],
      ["/api/servers/srv-1/relocate", {}, "targetNodeId"],
    ];

    for (const [path_, body, expected] of cases) {
      const res = await app.request(path_, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect([path_, res.status]).toEqual([path_, 400]);
      const envelope = (await res.json()) as Envelope & {
        details?: { issues?: Array<{ path: string; message: string }> };
      };
      expect(envelope).toMatchObject({ error: "invalid_request", code: "invalid_request" });
      const issues = envelope.details?.issues ?? [];
      expect(
        issues.some((issue) => issue.path.includes(expected) || issue.message.includes(expected)),
      ).toBe(true);
    }
  });

  it("answers 400 invalid_json rather than 500 for an unparseable body", async () => {
    const app = createApp(db, config);
    const res = await app.request("/api/servers/srv-1/relocate", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json", code: "invalid_json" });
  });

  it("keeps create and import failures on 400 with per-route codes", async () => {
    const app = createApp(db, config);

    const create = await app.request("/api/servers", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ skillName: "games.does-not-exist", serverName: "Nope" }),
    });
    expect(create.status).toBe(400);
    const createBody = (await create.json()) as Envelope;
    expect(createBody.code).toBe("server_create_failed");
    expect(createBody.error).toMatch(/unknown_skill/);

    const imported = await app.request("/api/servers/import", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ sourcePath: path.join(root, "definitely-missing") }),
    });
    expect(imported.status).toBe(400);
    expect(((await imported.json()) as Envelope).code).toBe("server_import_failed");
  });

  it("answers 404 on the console route for an unknown server", async () => {
    const app = createApp(db, config);
    const res = await app.request("/api/servers/unknown/console", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ command: "list" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found", code: "server_not_found" });
  });
});
