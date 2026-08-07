import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { AppConfig } from "../config.js";
import { createDb, type Db } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { hashPassword } from "../auth/password.js";
import { createSession, SESSION_COOKIE } from "../auth/session.js";
import { servers, users } from "../db/schema.js";

function writeSkill(dir: string, name: string): void {
  fs.mkdirSync(path.join(dir, "guides"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "metadata.yaml"),
    [
      `name: ${name}`,
      "version: 0.1.0",
      "game: Demo",
      "description: Test",
      "tags: [test]",
      "containerSupport: none",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(dir, "guides", "INSTALL.md"), "# Install\n");
}

describe("files API", () => {
  let db: Db;
  let sqlite: Database.Database;
  let root: string;
  let cookie: string;
  let config: AppConfig;
  let serverId: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-files-api-"));
    const dbPath = path.join(root, "playon.sqlite");
    applyBootstrap(dbPath);
    const handle = createDb(dbPath);
    db = handle.db;
    sqlite = handle.sqlite;

    const platformRoot = path.join(root, "platform");
    const skillsRoot = path.join(root, "skills");
    fs.mkdirSync(path.join(platformRoot, "docker-basics"), { recursive: true });
    fs.mkdirSync(path.join(skillsRoot, "_drafts"), { recursive: true });
    writeSkill(path.join(platformRoot, "docker-basics"), "platform.docker-basics");
    writeSkill(path.join(skillsRoot, "games-demo"), "games.demo");

    config = {
      port: 0,
      advertiseHost: "127.0.0.1",
      dataRoot: root,
      dbPath,
      sessionSecret: "test-session-secret-at-least-32-chars!!",
      skillsRoots: [platformRoot, skillsRoot],
      llmMode: "openai_compatible",
      runtimeMode: "native",
    };

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

    serverId = "srv-files-1";
    const dataPath = path.join(root, "servers", serverId);
    fs.mkdirSync(path.join(dataPath, "game"), { recursive: true });
    fs.writeFileSync(path.join(dataPath, "game", "server.properties"), "motd=Hello\n");
    await db.insert(servers).values({
      id: serverId,
      name: "Files Test",
      game: "Demo",
      nodeId: null,
      runtimeMode: "native",
      status: "stopped",
      dataPath,
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

  it("lists and reads server files, then writes", async () => {
    const app = createApp(db, config);
    const list = await app.request(`/api/servers/${serverId}/fs?path=game`, {
      headers: { cookie },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      entries: Array<{ name: string; type: string }>;
      writable: boolean;
    };
    expect(listBody.writable).toBe(true);
    expect(listBody.entries.some((e) => e.name === "server.properties")).toBe(true);

    const read = await app.request(
      `/api/servers/${serverId}/fs/content?path=${encodeURIComponent("game/server.properties")}`,
      { headers: { cookie } },
    );
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as { content: string; truncated: boolean };
    expect(readBody.content).toContain("motd=Hello");
    expect(readBody.truncated).toBe(false);

    const write = await app.request(`/api/servers/${serverId}/fs/content`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ path: "game/server.properties", content: "motd=Tweaked\n" }),
    });
    expect(write.status).toBe(200);
    expect(
      fs.readFileSync(path.join(root, "servers", serverId, "game", "server.properties"), "utf8"),
    ).toBe("motd=Tweaked\n");
  });

  it("lists skill files and forbids writing platform skills", async () => {
    const app = createApp(db, config);

    const list = await app.request(
      `/api/skills/${encodeURIComponent("games.demo")}/fs?path=.`,
      { headers: { cookie } },
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      entries: Array<{ name: string }>;
      writable: boolean;
      source: string;
    };
    expect(listBody.source).toBe("installed");
    expect(listBody.writable).toBe(true);
    expect(listBody.entries.some((e) => e.name === "metadata.yaml")).toBe(true);

    const writeInstalled = await app.request(
      `/api/skills/${encodeURIComponent("games.demo")}/fs/content`,
      {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ path: "guides/INSTALL.md", content: "# Edited\n" }),
      },
    );
    expect(writeInstalled.status).toBe(200);

    const platformWrite = await app.request(
      `/api/skills/${encodeURIComponent("platform.docker-basics")}/fs/content`,
      {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ path: "guides/INSTALL.md", content: "nope" }),
      },
    );
    expect(platformWrite.status).toBe(403);
    const errBody = (await platformWrite.json()) as { error: string };
    expect(errBody.error).toMatch(/writable_skill_required/);
  });

  it("rejects unauthenticated fs access", async () => {
    const app = createApp(db, config);
    const res = await app.request(`/api/servers/${serverId}/fs`);
    expect(res.status).toBe(403);
    const skillRes = await app.request(`/api/skills/${encodeURIComponent("games.demo")}/fs`);
    expect(skillRes.status).toBe(403);
  });
});
