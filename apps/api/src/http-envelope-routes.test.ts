import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { createDb, type Db } from "./db/client.js";
import { applyBootstrap } from "./db/migrate.js";
import { hashPassword } from "./auth/password.js";
import { createSession, SESSION_COOKIE } from "./auth/session.js";
import { nodes, servers, users } from "./db/schema.js";

type Envelope = { error: string; code?: string; details?: unknown };

/**
 * Routes migrated to the shared envelope: session, servers list/detail, every
 * mutating server route (create, import, start, stop, restart, delete, relocate,
 * console), the skill library, watchers, the player panel, and the nodes,
 * snapshots, backups, settings and users groups. Status codes and `error` text
 * must match pre-envelope behaviour; `code` is the addition.
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

  /** An uninstallable skill under `dataRoot/skills`, discoverable by the routes. */
  function installDemoSkill(): void {
    const skillDir = path.join(root, "skills", "demo");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "metadata.yaml"),
      [
        "name: demo.skill",
        "version: 1.0.0",
        "game: Demo",
        "description: Envelope fixture",
        "tags: [test]",
        "containerSupport: none",
      ].join("\n"),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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

  it("gates the skill library on the same 403 forbidden envelope", async () => {
    const app = createApp(db, config);
    const forbidden = { error: "forbidden", code: "forbidden" };
    const attempts: Array<[string, RequestInit]> = [
      ["/api/skills", {}],
      ["/api/skills/catalog", {}],
      ["/api/skills/drafts", {}],
      ["/api/skills/demo.skill", {}],
      ["/api/skills/demo.skill/fs", {}],
      ["/api/skills/demo.skill/fs/content?path=metadata.yaml", {}],
      ["/api/skills/demo.skill/fs/content", { method: "PUT" }],
      ["/api/skills/demo.skill/export", {}],
      ["/api/skills/demo.skill", { method: "DELETE" }],
      ["/api/skills/import", { method: "POST" }],
      ["/api/skills/install-from-catalog", { method: "POST" }],
      ["/api/skills/promote-server", { method: "POST" }],
      ["/api/skills/drafts/demo/promote", { method: "POST" }],
    ];

    for (const [path_, init] of attempts) {
      const anon = await app.request(path_, init);
      expect([path_, anon.status]).toEqual([path_, 403]);
      expect(await anon.json()).toEqual(forbidden);

      const asPlayer = await app.request(path_, { ...init, headers: { cookie: playerCookie } });
      expect([path_, asPlayer.status]).toEqual([path_, 403]);
      expect(await asPlayer.json()).toEqual(forbidden);
    }
  });

  it("keeps skill lookups on 404 with their own text and per-route codes", async () => {
    const app = createApp(db, config);
    const cases: Array<[string, RequestInit, string, RegExp]> = [
      ["/api/skills?serverId=unknown", {}, "server_not_found", /^server_not_found$/],
      ["/api/skills/ghost.skill", {}, "unknown_skill", /^unknown_skill$/],
      ["/api/skills/ghost.skill/export", {}, "skill_export_failed", /unknown_skill/],
      ["/api/skills/ghost.skill", { method: "DELETE" }, "skill_uninstall_failed", /unknown_skill/],
      [
        "/api/skills/drafts/ghost/promote",
        { method: "POST" },
        "skill_draft_promote_failed",
        /unknown_draft/,
      ],
    ];

    for (const [path_, init, code, errorPattern] of cases) {
      const res = await app.request(path_, { ...init, headers: { cookie } });
      expect([path_, res.status]).toEqual([path_, 404]);
      const body = (await res.json()) as Envelope;
      expect([path_, body.code]).toEqual([path_, code]);
      expect(body.error).toMatch(errorPattern);
    }
  });

  it("keeps the skill FS status vocabulary under the envelope", async () => {
    const app = createApp(db, config);
    installDemoSkill();

    const unknown = await app.request("/api/skills/ghost.skill/fs", { headers: { cookie } });
    expect(unknown.status).toBe(404);
    const unknownBody = (await unknown.json()) as Envelope;
    expect(unknownBody.code).toBe("skill_fs_list_failed");
    expect(unknownBody.error).toMatch(/unknown_skill/);

    const noPath = await app.request("/api/skills/demo.skill/fs/content", {
      headers: { cookie },
    });
    expect(noPath.status).toBe(400);
    expect(await noPath.json()).toEqual({ error: "path_required", code: "path_required" });

    const noContent = await app.request("/api/skills/demo.skill/fs/content", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ path: "notes.md" }),
    });
    expect(noContent.status).toBe(400);
    expect(await noContent.json()).toEqual({
      error: "content_required",
      code: "content_required",
    });

    const escape = await app.request("/api/skills/demo.skill/fs?path=../../etc", {
      headers: { cookie },
    });
    expect(escape.status).toBe(400);
    expect(((await escape.json()) as Envelope).code).toBe("skill_fs_list_failed");
  });

  it("answers 409 skill_in_use with the blocking servers in details", async () => {
    const app = createApp(db, config);
    installDemoSkill();
    const dataPath = path.join(root, "servers", "srv-1");
    fs.mkdirSync(dataPath, { recursive: true });
    fs.writeFileSync(path.join(dataPath, "skill.json"), JSON.stringify({ skillName: "demo.skill" }));

    const blocked = await app.request("/api/skills/demo.skill", {
      method: "DELETE",
      headers: { cookie },
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({
      error: "skill_in_use",
      code: "skill_in_use",
      details: { servers: [{ id: "srv-1", name: "Envelope Test" }] },
    });

    const forced = await app.request("/api/skills/demo.skill?force=1", {
      method: "DELETE",
      headers: { cookie },
    });
    expect(forced.status).toBe(200);
  });

  it("validates the catalog install body before reaching the catalog", async () => {
    const app = createApp(db, config);

    const missing = await app.request("/api/skills/install-from-catalog", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: "name_or_downloadUrl_required",
      code: "name_or_downloadUrl_required",
    });

    const badUrl = await app.request("/api/skills/install-from-catalog", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ downloadUrl: "not-a-url" }),
    });
    expect(badUrl.status).toBe(400);
    expect((await badUrl.json()) as Envelope).toMatchObject({
      error: "invalid_request",
      code: "invalid_request",
    });

    const malformed = await app.request("/api/skills/install-from-catalog", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid_json", code: "invalid_json" });
  });

  it("answers 502 when the skills catalog is unreachable", async () => {
    vi.stubEnv("PLAYON_SKILLS_CATALOG_URL", "https://catalog.test/index.json");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("catalog_offline");
      }),
    );

    const app = createApp(db, config);
    const res = await app.request("/api/skills/catalog", { headers: { cookie } });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "catalog_offline",
      code: "skills_catalog_unavailable",
      details: { catalogUrl: "https://catalog.test/index.json" },
    });
  });

  it("answers 404 unknown_server_skill when promoting a missing server skill", async () => {
    const app = createApp(db, config);
    const res = await app.request("/api/skills/promote-server", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ serverId: "srv-1", skillSlug: "ghost" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe("skill_promote_server_failed");
    expect(body.error).toMatch(/unknown_server_skill/);

    const invalid = await app.request("/api/skills/promote-server", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ serverId: "srv-1" }),
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()) as Envelope).toMatchObject({ code: "invalid_request" });
  });

  it("gates every watcher route on the same 403 forbidden envelope", async () => {
    const app = createApp(db, config);
    const forbidden = { error: "forbidden", code: "forbidden" };
    const attempts: Array<[string, RequestInit]> = [
      ["/api/watchers", {}],
      ["/api/servers/srv-1/watchers", {}],
      ["/api/watchers/w-1", {}],
      ["/api/watchers/w-1/runs", {}],
      ["/api/watchers", { method: "POST" }],
      ["/api/watchers/w-1", { method: "PATCH" }],
      ["/api/watchers/w-1", { method: "DELETE" }],
      ["/api/watchers/w-1/run", { method: "POST" }],
    ];

    for (const [path_, init] of attempts) {
      const anon = await app.request(path_, init);
      expect([path_, anon.status]).toEqual([path_, 403]);
      expect(await anon.json()).toEqual(forbidden);

      const asPlayer = await app.request(path_, { ...init, headers: { cookie: playerCookie } });
      expect([path_, asPlayer.status]).toEqual([path_, 403]);
      expect(await asPlayer.json()).toEqual(forbidden);
    }
  });

  it("answers the same 404 watcher_not_found across watcher routes", async () => {
    const app = createApp(db, config);
    const notFound = { error: "not_found", code: "watcher_not_found" };
    const attempts: Array<[string, RequestInit]> = [
      ["/api/watchers/ghost", {}],
      ["/api/watchers/ghost/runs", {}],
      ["/api/watchers/ghost/run", { method: "POST" }],
      ["/api/watchers/ghost", { method: "DELETE" }],
      [
        "/api/watchers/ghost",
        { method: "PATCH", body: JSON.stringify({ name: "Renamed" }) },
      ],
    ];

    for (const [path_, init] of attempts) {
      const res = await app.request(path_, {
        ...init,
        headers: { cookie, "content-type": "application/json" },
      });
      expect([path_, res.status]).toEqual([path_, 404]);
      expect(await res.json()).toEqual(notFound);
    }
  });

  it("renders watcher contract failures as 400 invalid_request with issues", async () => {
    const app = createApp(db, config);

    const create = await app.request("/api/watchers", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "No trigger" }),
    });
    expect(create.status).toBe(400);
    const createBody = (await create.json()) as Envelope & {
      details?: { issues?: Array<{ path: string }> };
    };
    expect(createBody).toMatchObject({ error: "invalid_request", code: "invalid_request" });
    expect(createBody.details?.issues?.map((issue) => issue.path)).toContain("serverId");

    const malformed = await app.request("/api/watchers", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid_json", code: "invalid_json" });
  });

  it("keeps panel input open to players but validates the body", async () => {
    const app = createApp(db, config);

    const ok = await app.request("/api/panel/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "readiness", serverId: "srv-1" }),
    });
    expect(ok.status).toBe(200);

    const malformed = await app.request("/api/panel/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid_json", code: "invalid_json" });

    const badType = await app.request("/api/panel/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "kick" }),
    });
    expect(badType.status).toBe(400);
    expect((await badType.json()) as Envelope).toMatchObject({ code: "invalid_request" });
  });

  it("answers 429 rate_limited once panel input floods", async () => {
    const app = createApp(db, config);
    const send = () =>
      app.request("/api/panel/input", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "203.0.113.7" },
        body: JSON.stringify({ type: "readiness", serverId: "srv-1" }),
      });

    for (let i = 0; i < 40; i += 1) {
      expect((await send()).status).toBe(200);
    }
    const limited = await send();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited", code: "rate_limited" });
  });

  /** Anonymous and under-privileged callers must be indistinguishable. */
  async function expectForbidden(
    app: ReturnType<typeof createApp>,
    attempts: Array<[string, RequestInit]>,
  ): Promise<void> {
    const forbidden = { error: "forbidden", code: "forbidden" };
    for (const [path_, init] of attempts) {
      const anon = await app.request(path_, init);
      expect([path_, anon.status]).toEqual([path_, 403]);
      expect(await anon.json()).toEqual(forbidden);

      const asPlayer = await app.request(path_, { ...init, headers: { cookie: playerCookie } });
      expect([path_, asPlayer.status]).toEqual([path_, 403]);
      expect(await asPlayer.json()).toEqual(forbidden);
    }
  }

  /** A registered node the heartbeat has not touched for long enough to be offline. */
  async function insertStaleNode(id: string): Promise<void> {
    await db.insert(nodes).values({
      id,
      name: id,
      os: "linux",
      docker: true,
      lastSeenAt: new Date(Date.now() - 10 * 60_000),
      kind: "lan",
    });
  }

  it("gates every node route on the same 403 forbidden envelope", async () => {
    const app = createApp(db, config);
    await expectForbidden(app, [
      ["/api/nodes", {}],
      ["/api/placement?skillName=demo.skill", {}],
      ["/api/nodes/add", { method: "POST" }],
      ["/api/nodes/bootstrap-token", { method: "POST" }],
      ["/api/nodes/node-a", { method: "DELETE" }],
      ["/api/nodes/node-a/update", { method: "POST" }],
      ["/api/nodes/node-a/manage", { method: "POST" }],
      ["/api/nodes/node-a/manage/suggest", { method: "POST" }],
      ["/api/nodes/node-a/install-docker", { method: "POST" }],
      ["/api/nodes/node-a/install-docker/token", { method: "POST" }],
    ]);
  });

  it("keeps node routes promoting an unknown node id to 404", async () => {
    const app = createApp(db, config);
    const cases: Array<[string, RequestInit, string]> = [
      ["/api/nodes/ghost", { method: "DELETE" }, "remove_node_failed"],
      ["/api/nodes/ghost/manage/suggest", { method: "POST" }, "manage_suggest_failed"],
      [
        "/api/nodes/ghost/install-docker/token",
        { method: "POST" },
        "install_docker_token_failed",
      ],
    ];

    for (const [path_, init, code] of cases) {
      const res = await app.request(path_, { ...init, headers: { cookie } });
      expect([path_, res.status]).toEqual([path_, 404]);
      const body = (await res.json()) as Envelope;
      expect([path_, body.code]).toEqual([path_, code]);
      expect(body.error).toMatch(/unknown_node/);
    }
  });

  it("answers 409 when a registered node is not online", async () => {
    const app = createApp(db, config);
    await insertStaleNode("stale-node");

    const res = await app.request("/api/nodes/stale-node/manage/suggest", {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe("manage_suggest_failed");
    expect(body.error).toMatch(/node_not_online/);
  });

  it("renders node contract failures as 400 invalid_request with issues", async () => {
    const app = createApp(db, config);
    const cases: Array<[string, unknown, string]> = [
      ["/api/nodes/add", { kind: "lan" }, "host"],
      ["/api/nodes/bootstrap-token", {}, "kind"],
      ["/api/nodes/node-a/manage", {}, "sourcePath"],
      ["/api/nodes/node-a/install-docker", { host: "10.0.0.4" }, "username"],
    ];

    for (const [path_, body, expected] of cases) {
      const res = await app.request(path_, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect([path_, res.status]).toEqual([path_, 400]);
      const envelope = (await res.json()) as Envelope & {
        details?: { issues?: Array<{ path: string }> };
      };
      expect(envelope).toMatchObject({ error: "invalid_request", code: "invalid_request" });
      expect(envelope.details?.issues?.map((issue) => issue.path)).toContain(expected);
    }
  });

  it("keeps the placement route's own 400 and 404 vocabulary", async () => {
    const app = createApp(db, config);

    const missing = await app.request("/api/placement", { headers: { cookie } });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: "skillName_required",
      code: "skillName_required",
    });

    const unknown = await app.request("/api/placement?skillName=games.ghost", {
      headers: { cookie },
    });
    expect(unknown.status).toBe(404);
    const body = (await unknown.json()) as Envelope;
    expect(body.code).toBe("placement_failed");
    expect(body.error).toMatch(/unknown_skill/);
  });

  it("gates snapshot and backup routes on the same 403 forbidden envelope", async () => {
    const app = createApp(db, config);
    await expectForbidden(app, [
      ["/api/snapshots", {}],
      ["/api/snapshots", { method: "POST" }],
      ["/api/snapshots/snap-1/restore", { method: "POST" }],
      ["/api/backups/target", {}],
      ["/api/backups/target", { method: "PUT" }],
      ["/api/backups/offnode", {}],
      ["/api/backups/offnode", { method: "POST" }],
      ["/api/backups/offnode/bk-1/restore", { method: "POST" }],
    ]);
  });

  it("keeps snapshot failures on their pre-envelope statuses", async () => {
    const app = createApp(db, config);

    const noServer = await app.request("/api/snapshots", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(noServer.status).toBe(400);
    const noServerBody = (await noServer.json()) as Envelope & {
      details?: { issues?: Array<{ path: string }> };
    };
    expect(noServerBody).toMatchObject({ error: "invalid_request", code: "invalid_request" });
    expect(noServerBody.details?.issues?.map((issue) => issue.path)).toContain("serverId");

    const unknownServer = await app.request("/api/snapshots", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ serverId: "ghost" }),
    });
    expect(unknownServer.status).toBe(404);
    const unknownServerBody = (await unknownServer.json()) as Envelope;
    expect(unknownServerBody.code).toBe("snapshot_create_failed");
    expect(unknownServerBody.error).toMatch(/unknown_server/);

    const restore = await app.request("/api/snapshots/ghost/restore", {
      method: "POST",
      headers: { cookie },
    });
    expect(restore.status).toBe(404);
    const restoreBody = (await restore.json()) as Envelope;
    expect(restoreBody.code).toBe("snapshot_restore_failed");
    expect(restoreBody.error).toMatch(/unknown_snapshot/);
  });

  it("keeps off-node backup failures on their pre-envelope statuses", async () => {
    const app = createApp(db, config);

    const neither = await app.request("/api/backups/offnode", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(neither.status).toBe(400);
    expect(await neither.json()).toEqual({
      error: "serverId_or_snapshotId_required",
      code: "serverId_or_snapshotId_required",
    });

    const noTarget = await app.request("/api/backups/offnode", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ snapshotId: "snap-ghost" }),
    });
    expect(noTarget.status).toBe(400);
    const noTargetBody = (await noTarget.json()) as Envelope;
    expect(noTargetBody.code).toBe("offnode_backup_failed");
    expect(noTargetBody.error).toMatch(/backup_target_not_configured/);

    // No body at all: every field is optional, so the backup id in the path is
    // what the route reports on.
    const restore = await app.request("/api/backups/offnode/ghost/restore", {
      method: "POST",
      headers: { cookie },
    });
    expect(restore.status).toBe(404);
    const restoreBody = (await restore.json()) as Envelope;
    expect(restoreBody.code).toBe("offnode_restore_failed");
    expect(restoreBody.error).toMatch(/unknown_offnode_backup/);
  });

  it("validates the backup target before writing it", async () => {
    const app = createApp(db, config);

    const empty = await app.request("/api/backups/target", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ rootPath: "" }),
    });
    expect(empty.status).toBe(400);
    const emptyBody = (await empty.json()) as Envelope & {
      details?: { issues?: Array<{ path: string }> };
    };
    expect(emptyBody).toMatchObject({ error: "invalid_request", code: "invalid_request" });
    expect(emptyBody.details?.issues?.map((issue) => issue.path)).toContain("rootPath");

    const rootPath = path.join(root, "offnode");
    const set = await app.request("/api/backups/target", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ rootPath }),
    });
    expect(set.status).toBe(200);

    const read = await app.request("/api/backups/target", { headers: { cookie } });
    expect(read.status).toBe(200);
    expect((await read.json()) as { target: { rootPath: string } }).toEqual({
      target: { rootPath },
    });
  });

  it("gates every settings route on the same 403 forbidden envelope", async () => {
    const app = createApp(db, config);
    await expectForbidden(app, [
      ["/api/settings/llm", {}],
      ["/api/settings/llm", { method: "PUT" }],
      ["/api/settings/llm/ollama/status", {}],
      ["/api/settings/llm/ollama/job", {}],
      ["/api/settings/llm/ollama/install", { method: "POST" }],
      ["/api/settings/llm/ollama/pull", { method: "POST" }],
      ["/api/settings/nodes", {}],
      ["/api/settings/nodes", { method: "PUT" }],
      ["/api/settings/cloud", {}],
      ["/api/settings/cloud/vultr/connect", { method: "POST" }],
      ["/api/settings/cloud/vultr", { method: "DELETE" }],
      ["/api/access-tokens", {}],
      ["/api/access-tokens", { method: "POST" }],
      ["/api/access-tokens/tok-1", { method: "DELETE" }],
      ["/api/updates/status", {}],
      ["/api/updates/home/apply", { method: "POST" }],
    ]);
  });

  it("renders settings contract failures as 400 invalid_request with issues", async () => {
    const app = createApp(db, config);
    const cases: Array<[string, string, unknown, string]> = [
      ["/api/settings/llm", "PUT", {}, "preset_or_provider_required"],
      ["/api/settings/nodes", "PUT", {}, "localComputeEnabled"],
      ["/api/settings/llm/ollama/pull", "POST", {}, "model"],
    ];

    for (const [path_, method, body, expected] of cases) {
      const res = await app.request(path_, {
        method,
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

  it("issues an access token with no request body and 404s an unknown revoke", async () => {
    const app = createApp(db, config);

    const created = await app.request("/api/access-tokens", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as { token: { id: string; name: string } };
    expect(createdBody.token.name).toBe("MCP token");

    const revoked = await app.request(`/api/access-tokens/${createdBody.token.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(revoked.status).toBe(200);

    const again = await app.request(`/api/access-tokens/${createdBody.token.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({
      error: "not_found",
      code: "access_token_not_found",
    });
  });

  it("answers 503 when the Vultr OAuth app is not configured", async () => {
    vi.stubEnv("PLAYON_VULTR_CLIENT_ID", "");
    const app = createApp(db, config);

    const res = await app.request("/api/settings/cloud/vultr/connect", {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as Envelope & { details?: { hint?: string } };
    expect(body).toMatchObject({
      error: "vultr_oauth_not_configured",
      code: "vultr_oauth_not_configured",
    });
    expect(body.details?.hint).toMatch(/PLAYON_VULTR_CLIENT_ID/);
  });

  it("answers 400 invalid_state on an unmatched Vultr callback", async () => {
    const app = createApp(db, config);
    const res = await app.request("/api/settings/cloud/vultr/callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "nope", code: "abc" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_state", code: "invalid_state" });
  });

  it("keeps user creation on 403 / 400 / 409 with codes", async () => {
    const app = createApp(db, config);
    await expectForbidden(app, [["/api/users", { method: "POST" }]]);

    const invalid = await app.request("/api/users", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ username: "ab", password: "short", role: "owner" }),
    });
    expect(invalid.status).toBe(400);
    const invalidBody = (await invalid.json()) as Envelope & {
      details?: { issues?: Array<{ path: string }> };
    };
    expect(invalidBody).toMatchObject({ error: "invalid_request", code: "invalid_request" });
    expect(invalidBody.details?.issues?.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["username", "password", "role"]),
    );

    const taken = await app.request("/api/users", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "password123", role: "operator" }),
    });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "username_taken", code: "username_taken" });

    const ok = await app.request("/api/users", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ username: "second", password: "password123", role: "operator" }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { user: { role: string } }).user.role).toBe("operator");
  });
});
