import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { expect, vi } from "vitest";
import { createApp } from "./app.js";
import { hashPassword } from "./auth/password.js";
import { createSession, SESSION_COOKIE } from "./auth/session.js";
import type { AppConfig } from "./config.js";
import { createDb, type Db } from "./db/client.js";
import { applyBootstrap } from "./db/migrate.js";
import { nodes, servers, users } from "./db/schema.js";

export type Envelope = { error: string; code?: string; details?: unknown };

export type EnvelopeEnv = {
  db: Db;
  sqlite: Database.Database;
  root: string;
  cookie: string;
  playerCookie: string;
  config: AppConfig;
};

/**
 * Shared fixture for the split envelope-route files. Windows CI cannot keep the
 * original ~57-test / ~124s file in one vitest worker (#912 / vitest#6511).
 */
export async function createEnvelopeEnv(): Promise<EnvelopeEnv> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-http-envelope-"));
  const dbPath = path.join(root, "playon.sqlite");
  applyBootstrap(dbPath);
  const handle = createDb(dbPath);
  const db = handle.db;
  const sqlite = handle.sqlite;

  const skillsRoot = path.join(root, "skills");
  fs.mkdirSync(skillsRoot, { recursive: true });

  const config: AppConfig = {
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

  return {
    db,
    sqlite,
    root,
    cookie: `${SESSION_COOKIE}=${await createSession(db, "owner-1")}`,
    playerCookie: `${SESSION_COOKIE}=${await createSession(db, "player-1")}`,
    config,
  };
}

export function cleanupEnvelopeEnv(env: EnvelopeEnv): void {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  try {
    env.sqlite.close();
  } catch {
    // ignore
  }
  try {
    fs.rmSync(env.root, { recursive: true, force: true });
  } catch {
    // Windows may briefly lock WAL files
  }
}

/** An uninstallable skill under `dataRoot/skills`, discoverable by the routes. */
export function installDemoSkill(root: string): void {
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

/** Anonymous and under-privileged callers must be indistinguishable. */
export async function expectForbidden(
  app: ReturnType<typeof createApp>,
  playerCookie: string,
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
export async function insertStaleNode(db: Db, id: string): Promise<void> {
  await db.insert(nodes).values({
    id,
    name: id,
    os: "linux",
    docker: true,
    lastSeenAt: new Date(Date.now() - 10 * 60_000),
    kind: "lan",
  });
}

/** Opens a session on `srv-1` through the route the UI uses. */
export async function startConversation(
  app: ReturnType<typeof createApp>,
  cookie: string,
  title = "Paper night",
): Promise<string> {
  const created = await app.request("/api/servers/srv-1/conversations", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  expect(created.status).toBe(200);
  return ((await created.json()) as { conversation: { id: string } }).conversation.id;
}
