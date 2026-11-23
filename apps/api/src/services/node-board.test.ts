import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE, createSession } from "../auth/session.js";
import type { AppConfig } from "../config.js";
import { createApp } from "../app.js";
import { createDb } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { nodes, users } from "../db/schema.js";
import { createAccessToken } from "./access-tokens.js";
import { listOperatorNodes } from "./node-board.js";
import { invokeRegisteredMcpTool } from "./mcp.js";
import { createPlayOnToolRegistry } from "./tools.js";
import type Database from "better-sqlite3";

const temps: Array<{ root: string; sqlite: Database.Database }> = [];

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

function testConfig(dataRoot: string): AppConfig {
  return {
    port: 0,
    advertiseHost: "127.0.0.1",
    dataRoot,
    dbPath: path.join(dataRoot, "playon.sqlite"),
    sessionSecret: "test-session-secret-at-least-32-chars!!",
    skillsRoots: [],
    llmMode: "openai_compatible",
    runtimeMode: "docker",
    nodeToken: "super-secret-node-token",
  };
}

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-board-"));
  applyBootstrap(path.join(root, "playon.sqlite"));
  const { db, sqlite } = createDb(path.join(root, "playon.sqlite"));
  temps.push({ root, sqlite });
  const now = new Date();
  await db.insert(users).values([
    {
      id: "owner-1",
      username: "owner",
      displayName: "Owner",
      passwordHash: "x",
      role: "owner",
      createdAt: now,
    },
    {
      id: "op-1",
      username: "op",
      displayName: "Op",
      passwordHash: "x",
      role: "operator",
      createdAt: now,
    },
    {
      id: "player-1",
      username: "player",
      displayName: "Player",
      passwordHash: "x",
      role: "player",
      createdAt: now,
    },
  ]);
  await db.insert(nodes).values([
    {
      id: "playon-win-1",
      name: "playon-win-1",
      os: "windows",
      docker: false,
      native: true,
      steamcmd: true,
      lastSeenAt: now,
      kind: "lan",
      tunnelStatus: "none",
      joinHost: "172.16.0.94",
      wgPublicKey: "pubkey-should-not-leak",
      wgPrivateKeyEncrypted: "priv-should-not-leak",
    },
    {
      id: "playon-win-old",
      name: "old-win",
      os: "windows",
      docker: false,
      native: true,
      steamcmd: false,
      lastSeenAt: new Date(now.getTime() - 120_000),
      kind: "lan",
      tunnelStatus: "none",
    },
  ]);
  const config = testConfig(root);
  const app = createApp(db, config);
  const cookie = `${SESSION_COOKIE}=${await createSession(db, "owner-1")}`;
  return { db, app, cookie, plane: app.controlPlane };
}

function principal(userId: string) {
  return {
    id: "tok-1",
    name: "lab",
    userId,
    autoApproveConfirms: true,
  };
}

describe("nodes_list operator inventory", () => {
  it("matches GET /api/nodes and omits key material", async () => {
    const { app, cookie, plane } = await setup();
    const fromService = await listOperatorNodes(plane);
    const res = await app.request("/api/nodes", { headers: { cookie } });
    expect(res.status).toBe(200);
    const fromRoute = await res.json();
    expect(JSON.parse(JSON.stringify(fromService))).toEqual(fromRoute);

    const win = fromService.nodes.find((n) => n.id === "playon-win-1");
    const old = fromService.nodes.find((n) => n.id === "playon-win-old");
    expect(win).toMatchObject({
      id: "playon-win-1",
      os: "windows",
      status: "online",
      joinHost: "172.16.0.94",
    });
    expect(old?.status).toBe("offline");
    expect(fromService.nodeTokenConfigured).toBe(true);

    const blob = JSON.stringify(fromService);
    expect(blob).not.toContain("priv-should-not-leak");
    expect(blob).not.toContain("pubkey-should-not-leak");
    expect(blob).not.toContain("super-secret-node-token");
    expect(blob).not.toContain("wgPrivateKey");
    expect(blob).not.toContain("wgPublicKey");
  });

  it("still rejects a bearer token on GET /api/nodes", async () => {
    const { db, app, cookie } = await setup();
    const created = await createAccessToken(db, {
      name: "mcp-only",
      userId: "owner-1",
      autoApproveConfirms: true,
    });
    const denied = await app.request("/api/nodes", {
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "forbidden", code: "forbidden" });

    const allowed = await app.request("/api/nodes", { headers: { cookie } });
    expect(allowed.status).toBe(200);
  });

  it("allows operator and owner MCP callers and refuses a player", async () => {
    const { plane } = await setup();
    const { registry } = createPlayOnToolRegistry(plane, {});
    const opts = { confirmPolicy: "auto" as const, autoApproveActor: "token:tok-1" };

    const asOwner = await invokeRegisteredMcpTool(
      plane,
      principal("owner-1"),
      registry,
      "nodes_list",
      {},
      opts,
    );
    expect(asOwner).toMatchObject({
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: "playon-win-1", status: "online" }),
      ]),
    });

    const asOperator = await invokeRegisteredMcpTool(
      plane,
      principal("op-1"),
      registry,
      "nodes_list",
      {},
      opts,
    );
    expect(asOperator).toMatchObject({
      nodes: expect.arrayContaining([expect.objectContaining({ id: "playon-win-1" })]),
    });

    const asPlayer = await invokeRegisteredMcpTool(
      plane,
      principal("player-1"),
      registry,
      "nodes_list",
      {},
      opts,
    );
    expect(asPlayer).toEqual({ error: "forbidden" });

    const missingUser = await invokeRegisteredMcpTool(
      plane,
      principal("deleted-user"),
      registry,
      "nodes_list",
      {},
      opts,
    );
    expect(missingUser).toEqual({ error: "forbidden" });

    const entry = registry.entries().find((e) => e.def.name === "nodes_list");
    expect(entry?.def.readOnly).toBe(true);
    expect(entry?.def.requiresConfirm).toBeFalsy();
    expect(entry?.workspacePolicy).toBe("none");
  });
});
