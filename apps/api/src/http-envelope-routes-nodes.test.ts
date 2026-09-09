import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import {
  cleanupEnvelopeEnv,
  createEnvelopeEnv,
  expectForbidden,
  insertStaleNode,
  type Envelope,
  type EnvelopeEnv,
} from "./http-envelope-routes-helpers.js";

/**
 * Split from http-envelope-routes.test.ts so Windows CI does not pack ~124s of
 * SQLite/app-bootstrap work into one vitest file near the birpc onTaskUpdate
 * cliff (#912 / vitest#6511).
 */
describe("transport error envelope — nodes, snapshots, backups", () => {
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

  it("gates every node route on the same 403 forbidden envelope", async () => {
    const app = createApp(db, config);
    await expectForbidden(app, playerCookie, [
      ["/api/nodes", {}],
      ["/api/placement?skillName=demo.skill", {}],
      ["/api/nodes/add", { method: "POST" }],
      ["/api/nodes/bootstrap-token", { method: "POST" }],
      ["/api/nodes/node-a", { method: "DELETE" }],
      ["/api/nodes/node-a/update", { method: "POST" }],
      ["/api/nodes/node-a/restart", { method: "POST" }],
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
      ["/api/nodes/ghost/restart", { method: "POST" }, "node_restart_failed"],
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
    await insertStaleNode(db, "stale-node");

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
    await expectForbidden(app, playerCookie, [
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

  it("stores a fetch_url LAN allowlist and rejects non-private entries", async () => {
    const app = createApp(db, config);

    const denied = await app.request("/api/settings/fetch", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ lanAllowlist: ["169.254.169.254"] }),
    });
    expect(denied.status).toBe(400);
    const deniedBody = (await denied.json()) as Envelope;
    expect(deniedBody.error).toMatch(/fetch_allowlist_not_private/);

    const set = await app.request("/api/settings/fetch", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ lanAllowlist: ["192.168.1.50", "10.0.0.0/8"] }),
    });
    expect(set.status).toBe(200);
    expect((await set.json()) as { fetch: { lanAllowlist: string[] } }).toEqual({
      fetch: { lanAllowlist: ["192.168.1.50", "10.0.0.0/8"] },
    });

    const read = await app.request("/api/settings/fetch", { headers: { cookie } });
    expect(read.status).toBe(200);
    expect((await read.json()) as { fetch: { lanAllowlist: string[] } }).toEqual({
      fetch: { lanAllowlist: ["192.168.1.50", "10.0.0.0/8"] },
    });
  });

});
