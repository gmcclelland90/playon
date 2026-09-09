import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import {
  cleanupEnvelopeEnv,
  createEnvelopeEnv,
  installDemoSkill,
  type Envelope,
  type EnvelopeEnv,
} from "./http-envelope-routes-helpers.js";

/**
 * Split from http-envelope-routes.test.ts so Windows CI does not pack ~124s of
 * SQLite/app-bootstrap work into one vitest file near the birpc onTaskUpdate
 * cliff (#912 / vitest#6511).
 */
describe("transport error envelope — skills, watchers, panel", () => {
  let env: EnvelopeEnv;
  let db: EnvelopeEnv["db"];
  let root: string;
  let cookie: string;
  let playerCookie: string;
  let config: EnvelopeEnv["config"];

  beforeEach(async () => {
    env = await createEnvelopeEnv();
    ({ db, root, cookie, playerCookie, config } = env);
  });

  afterEach(() => {
    cleanupEnvelopeEnv(env);
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
    installDemoSkill(root);

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
    installDemoSkill(root);
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

});
