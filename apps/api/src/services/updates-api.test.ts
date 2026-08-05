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
import { users } from "../db/schema.js";
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
});
