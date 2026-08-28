import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { hashPassword } from "../auth/password.js";
import { createSession, SESSION_COOKIE } from "../auth/session.js";
import type { AppConfig } from "../config.js";
import { createDb, type Db } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { servers, users } from "../db/schema.js";
import { ServerService } from "./servers.js";

const temps: Array<{ root: string; sqlite: Database.Database }> = [];

function tempEnv(): { db: Db; config: AppConfig; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-rename-"));
  const dbPath = path.join(root, "playon.db");
  applyBootstrap(dbPath);
  const config: AppConfig = {
    port: 0,
    dataRoot: root,
    dbPath,
    sessionSecret: "test-session-secret-at-least-32-chars!!",
    llmMode: "openai_compatible",
    runtimeMode: "native",
    advertiseHost: "127.0.0.1",
    skillsRoots: [path.join(root, "skills")],
  };
  const { db, sqlite } = createDb(dbPath);
  temps.push({ root, sqlite });
  return { db, config, root };
}

afterEach(() => {
  for (const entry of temps.splice(0)) {
    entry.sqlite.close();
    fs.rmSync(entry.root, { recursive: true, force: true });
  }
});

describe("server display-name rename", () => {
  it("persists the new name and leaves identity, ports path, and world folders alone", async () => {
    const { db, config, root } = tempEnv();
    const id = "B4KR2xjZnLFZjqrtqqvvL";
    const dataPath = path.join(root, "servers", id);
    const worldDir = path.join(dataPath, "game", "NewZombieLand3");
    fs.mkdirSync(worldDir, { recursive: true });
    fs.writeFileSync(path.join(worldDir, "map_t.bin"), "keep");
    const createdAt = new Date("2026-01-15T12:00:00.000Z");
    await db.insert(servers).values({
      id,
      name: "Friend Zomboid",
      game: "Project Zomboid",
      nodeId: null,
      runtimeMode: "native",
      status: "stopped",
      dataPath,
      createdAt,
    });

    const service = new ServerService(db, config);
    const renamed = await service.rename(id, "Basement PZ");
    expect(renamed).toMatchObject({
      id,
      name: "Basement PZ",
      game: "Project Zomboid",
      nodeId: null,
      runtimeMode: "native",
      status: "stopped",
      dataPath,
    });
    expect(renamed?.createdAt.getTime()).toBe(createdAt.getTime());

    const again = await service.get(id);
    expect(again?.name).toBe("Basement PZ");
    expect(again?.id).toBe(id);
    expect(again?.dataPath).toBe(dataPath);
    expect(fs.existsSync(path.join(worldDir, "map_t.bin"))).toBe(true);
    expect(fs.readdirSync(path.join(dataPath, "game"))).toEqual(["NewZombieLand3"]);
    expect(fs.existsSync(path.join(root, "servers", "Basement PZ"))).toBe(false);
  });

  it("returns null for an unknown id and does not create a row", async () => {
    const { db, config } = tempEnv();
    const service = new ServerService(db, config);
    expect(await service.rename("missing", "Nope")).toBeNull();
    expect(await service.list()).toEqual([]);
  });

  it("PATCH persists across a fresh service and leaves the data dir name as the id", async () => {
    const { db, config, root } = tempEnv();
    const now = new Date();
    await db.insert(users).values({
      id: "owner-1",
      username: "owner",
      displayName: "Owner",
      passwordHash: hashPassword("password123"),
      role: "owner",
      createdAt: now,
    });
    const cookie = `${SESSION_COOKIE}=${await createSession(db, "owner-1")}`;
    const id = "srv-rename-1";
    const dataPath = path.join(root, "servers", id);
    fs.mkdirSync(path.join(dataPath, "game", "NewZombieLand3"), { recursive: true });
    await db.insert(servers).values({
      id,
      name: "Old label",
      game: "Project Zomboid",
      nodeId: null,
      runtimeMode: "native",
      status: "stopped",
      dataPath,
      createdAt: now,
    });

    const app = createApp(db, config);
    const res = await app.request(`/api/servers/${id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "  Friday night PZ  " }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      server: { id: string; name: string; dataPath: string; game: string | null };
    };
    expect(body.server).toMatchObject({
      id,
      name: "Friday night PZ",
      dataPath,
      game: "Project Zomboid",
    });

    const listed = await app.request("/api/servers", { headers: { cookie } });
    const listBody = (await listed.json()) as {
      servers: Array<{ id: string; name: string; dataPath: string }>;
    };
    expect(listBody.servers).toHaveLength(1);
    expect(listBody.servers[0]).toMatchObject({ id, name: "Friday night PZ", dataPath });
    expect(fs.existsSync(path.join(dataPath, "game", "NewZombieLand3"))).toBe(true);
  });
});
