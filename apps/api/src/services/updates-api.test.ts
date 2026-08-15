import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { AppConfig } from "../config.js";
import { createDb, type Db } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { hashPassword } from "../auth/password.js";
import { createSession, SESSION_COOKIE } from "../auth/session.js";
import { users, nodes } from "../db/schema.js";
import { readAppVersion } from "./app-version.js";
import {
  NODE_SELF_UPDATE_VIA_ESM_BOOTSTRAP,
  WINDOWS_OTA_ESM_BOOTSTRAP_PROCESS_NAME,
  WINDOWS_OTA_ESM_BOOTSTRAP_REL,
} from "@playon/shared";
import { attachNodeJobPersist, nodeJobService, NodeJobService } from "./node-jobs.js";
import { clearUpdateManifestCacheForTests } from "./updates.js";

function testConfig(dataRoot: string): AppConfig {
  return {
    port: 0,
    advertiseHost: "127.0.0.1",
    dataRoot,
    dbPath: path.join(dataRoot, "playon.sqlite"),
    sessionSecret: "test-session-secret-at-least-32-chars!!",
    skillsRoots: [],
    llmMode: "openai_compatible",
    runtimeMode: "native",
  };
}

describe("updates API", () => {
  let db: Db;
  let sqlite: Database.Database;
  let root: string;
  let cookie: string;

  beforeEach(async () => {
    clearUpdateManifestCacheForTests();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-upd-api-"));
    const dbPath = path.join(root, "playon.sqlite");
    applyBootstrap(dbPath);
    const handle = createDb(dbPath);
    db = handle.db;
    sqlite = handle.sqlite;
    const now = new Date();
    await db.insert(users).values({
      id: "owner-1",
      username: "owner",
      displayName: "Owner",
      passwordHash: hashPassword("password123"),
      role: "owner",
      createdAt: now,
    });
    const sessionId = await createSession(db, "owner-1");
    cookie = `${SESSION_COOKIE}=${sessionId}`;
  });

  afterEach(() => {
    clearUpdateManifestCacheForTests();
    vi.unstubAllGlobals();
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

  it("rejects unauthenticated status", async () => {
    const app = createApp(db, testConfig(root));
    const res = await app.request("/api/updates/status");
    expect(res.status).toBe(403);
  });

  it("returns status for owner and includes version on health", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("latest.json")) {
          return {
            ok: true,
            json: async () => ({
              version: "9.9.9",
              channel: "stable",
              notesUrl: "https://playon.games/docs/changelog",
              home: {},
              node: {},
            }),
          };
        }
        return { ok: false, status: 404 };
      }),
    );
    const app = createApp(db, testConfig(root));
    const health = await app.request("/api/health");
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as { version?: string };
    expect(healthBody.version).toMatch(/^\d+\.\d+\.\d+/);

    const status = await app.request("/api/updates/status", {
      headers: { cookie },
    });
    expect(status.status).toBe(200);
    const body = (await status.json()) as {
      currentVersion: string;
      latestVersion: string;
      homeUpdateAvailable: boolean;
    };
    expect(body.latestVersion).toBe("9.9.9");
    expect(body.homeUpdateAvailable).toBe(true);
  });

  it("forbids non-owner home apply", async () => {
    await db.insert(users).values({
      id: "op-1",
      username: "ops",
      displayName: "Ops",
      passwordHash: hashPassword("password123"),
      role: "operator",
      createdAt: new Date(),
    });
    const opSession = await createSession(db, "op-1");
    const app = createApp(db, testConfig(root));
    const res = await app.request("/api/updates/home/apply", {
      method: "POST",
      headers: {
        cookie: `${SESSION_COOKIE}=${opSession}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("surfaces node self-update jobs on status and reuses an in-flight queue", async () => {
    const homeVer = readAppVersion();
    const sha = "a".repeat(64);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("latest.json")) {
          return {
            ok: true,
            json: async () => ({
              version: homeVer,
              channel: "stable",
              notesUrl: "https://playon.games/docs/changelog",
              home: {},
              node: {
                "linux-x64": {
                  downloadUrl: `https://github.com/gmcclelland90/playon/releases/download/v${homeVer}/playon-node-${homeVer}-linux-x64.tar.gz`,
                  sha256: sha,
                },
                "windows-x64": {
                  downloadUrl: `https://github.com/gmcclelland90/playon/releases/download/v${homeVer}/playon-node-${homeVer}-windows-x64.zip`,
                  sha256: sha,
                },
              },
            }),
          };
        }
        return { ok: false, status: 404 };
      }),
    );

    await db.insert(nodes).values([
      {
        id: "upd-win-parent",
        name: "playon-win-1",
        os: "windows",
        docker: false,
        native: true,
        lastSeenAt: new Date(),
        kind: "lan",
        agentVersion: "0.2.3",
        tunnelStatus: "none",
      },
      {
        id: "upd-win-parent-wsl",
        name: "playon-win-1-wsl",
        os: "linux",
        docker: true,
        native: true,
        lastSeenAt: new Date(),
        kind: "lan",
        agentVersion: "0.2.3",
        tunnelStatus: "none",
      },
      {
        id: "upd-zomboid",
        name: "zomboid",
        os: "linux",
        docker: true,
        native: true,
        lastSeenAt: new Date(),
        kind: "lan",
        agentVersion: "0.2.1",
        tunnelStatus: "none",
      },
    ]);

    const app = createApp(db, testConfig(root));
    attachNodeJobPersist(root);
    const queued = await app.request("/api/nodes/upd-win-parent/update", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(queued.status).toBe(200);
    const queuedBody = (await queued.json()) as { jobId: string; version: string };
    expect(queuedBody.jobId).toBeTruthy();
    expect(queuedBody.version).toBe(homeVer);

    const again = await app.request("/api/nodes/upd-win-parent/update", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as { jobId: string };
    expect(againBody.jobId).toBe(queuedBody.jobId);

    const status = await app.request("/api/updates/status", { headers: { cookie } });
    expect(status.status).toBe(200);
    const body = (await status.json()) as {
      homeCurrentEnoughForNodes: boolean;
      nodes: Array<{
        nodeId: string;
        updateJob: { jobId: string; status: string; version?: string } | null;
      }>;
    };
    expect(body.homeCurrentEnoughForNodes).toBe(true);
    const win = body.nodes.find((n) => n.nodeId === "upd-win-parent");
    const wsl = body.nodes.find((n) => n.nodeId === "upd-win-parent-wsl");
    const zomboid = body.nodes.find((n) => n.nodeId === "upd-zomboid");
    expect(win?.updateJob).toMatchObject({
      jobId: queuedBody.jobId,
      status: "running",
      version: homeVer,
    });
    expect(wsl?.updateJob).toBeNull();
    expect(zomboid?.updateJob).toBeNull();

    const tracked = nodeJobService.get(queuedBody.jobId);
    expect(tracked?.args.via).toBe(NODE_SELF_UPDATE_VIA_ESM_BOOTSTRAP);
    expect(nodeJobService.findActive("upd-win-parent", "fs_write_text")?.args.path).toBe(
      WINDOWS_OTA_ESM_BOOTSTRAP_REL,
    );
    expect(nodeJobService.findActive("upd-win-parent", "process_start")?.args.name).toBe(
      WINDOWS_OTA_ESM_BOOTSTRAP_PROCESS_NAME,
    );
    expect(nodeJobService.claimNext("upd-win-parent")?.kind).toBe("fs_write_text");

    const persistFile = path.join(root, "node-self-update-jobs.json");
    expect(fs.existsSync(persistFile)).toBe(true);
    const restored = new NodeJobService();
    restored.attachPersistFile(persistFile);
    expect(restored.get(queuedBody.jobId)?.status).toBe("running");
    expect(restored.get(queuedBody.jobId)?.nodeId).toBe("upd-win-parent");
    expect(restored.get(queuedBody.jobId)?.args.via).toBe(NODE_SELF_UPDATE_VIA_ESM_BOOTSTRAP);
    expect(restored.claimNext("upd-win-parent")?.kind).toBe("fs_write_text");
  });

  it("queues a claimable node_self_update for Windows agents that already import spawn", async () => {
    const homeVer = readAppVersion();
    const sha = "c".repeat(64);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("latest.json")) {
          return {
            ok: true,
            json: async () => ({
              version: homeVer,
              channel: "stable",
              notesUrl: "https://playon.games/docs/changelog",
              home: {},
              node: {
                "windows-x64": {
                  downloadUrl: `https://github.com/gmcclelland90/playon/releases/download/v${homeVer}/playon-node-${homeVer}-windows-x64.tar.gz`,
                  sha256: sha,
                },
              },
            }),
          };
        }
        return { ok: false, status: 404 };
      }),
    );
    await db.insert(nodes).values({
      id: "upd-win-current",
      name: "playon-win-current",
      os: "windows",
      docker: false,
      native: true,
      lastSeenAt: new Date(),
      kind: "lan",
      agentVersion: "0.2.5",
      tunnelStatus: "none",
    });
    const app = createApp(db, testConfig(root));
    attachNodeJobPersist(root);
    const queued = await app.request("/api/nodes/upd-win-current/update", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(queued.status).toBe(200);
    const body = (await queued.json()) as { jobId: string };
    expect(nodeJobService.get(body.jobId)?.args.via).toBeUndefined();
    expect(nodeJobService.findActive("upd-win-current", "fs_write_text")).toBeNull();
    expect(nodeJobService.claimNext("upd-win-current")?.kind).toBe("node_self_update");
  });
});
