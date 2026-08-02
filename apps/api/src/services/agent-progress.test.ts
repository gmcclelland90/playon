import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "../db/client.js";
import { applyBootstrap, migrateAgentProgressToGlobal } from "../db/migrate.js";
import { AgentProgressService, levelFromXp, titleFor } from "./agent-progress.js";

const temps: Array<{ root: string; sqlite: Database.Database }> = [];

afterAll(() => {
  for (const entry of temps.splice(0)) {
    try {
      entry.sqlite.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(entry.root, { recursive: true, force: true });
  }
});

describe("agent progress math", () => {
  it("levels up as XP accumulates", () => {
    expect(levelFromXp(0)).toBe(1);
    expect(levelFromXp(99)).toBe(1);
    expect(levelFromXp(100)).toBe(2);
    expect(levelFromXp(500)).toBeGreaterThan(2);
  });

  it("titles reflect level bands", () => {
    expect(titleFor("installer", 1)).toContain("Rookie");
    expect(titleFor("backup", 5)).toContain("Operator");
    expect(titleFor("troubleshooter", 12)).toContain("Legend");
  });
});

describe("global agent progress", () => {
  it("awards XP against a host-wide persona row", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-agent-xp-"));
    const dbPath = path.join(root, "playon.db");
    applyBootstrap(dbPath);
    const { db, sqlite } = createDb(dbPath);
    temps.push({ root, sqlite });

    const progress = new AgentProgressService(db);
    const first = await progress.award("installer", 50, "clean_install");
    expect(first.progress.xp).toBe(50);
    expect(first.progress.persona).toBe("installer");

    const second = await progress.award("installer", 60, "server_start");
    expect(second.progress.xp).toBe(110);
    expect(second.leveledUp).toBe(true);

    const cast = await progress.listCast();
    const installer = cast.find((a) => a.persona === "installer");
    expect(installer?.xp).toBe(110);
    expect(cast).toHaveLength(8);
  });

  it("awardForTools skips failed tool results", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-agent-tools-"));
    const dbPath = path.join(root, "playon.db");
    applyBootstrap(dbPath);
    const { db, sqlite } = createDb(dbPath);
    temps.push({ root, sqlite });

    const progress = new AgentProgressService(db);
    const awards = await progress.awardForTools("monitor", [
      { name: "servers_start", result: { ok: true } },
      { name: "servers_start", result: { error: "boom" } },
    ]);
    expect(awards).toHaveLength(1);
    expect(awards[0]!.progress.xp).toBe(15);
  });
});

describe("migrateAgentProgressToGlobal", () => {
  it("sums per-server XP into persona rows", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-agent-mig-"));
    const dbPath = path.join(root, "legacy.db");
    const raw = new Database(dbPath);
    temps.push({ root, sqlite: raw });

    raw.exec(`
      CREATE TABLE servers (id TEXT PRIMARY KEY);
      INSERT INTO servers (id) VALUES ('s1'), ('s2');
      CREATE TABLE agent_progress (
        server_id TEXT NOT NULL REFERENCES servers(id),
        persona TEXT NOT NULL,
        xp INTEGER NOT NULL DEFAULT 0,
        level INTEGER NOT NULL DEFAULT 1,
        title TEXT NOT NULL DEFAULT 'Rookie',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (server_id, persona)
      );
      INSERT INTO agent_progress (server_id, persona, xp, level, title, updated_at) VALUES
        ('s1', 'installer', 100, 2, 'Rookie installer', 1000),
        ('s2', 'installer', 50, 1, 'Rookie installer', 2000),
        ('s1', 'monitor', 20, 1, 'Rookie monitor', 1500);
    `);

    expect(migrateAgentProgressToGlobal(raw)).toBe(true);

    const cols = raw.prepare(`PRAGMA table_info(agent_progress)`).all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "server_id")).toBe(false);

    const rows = raw
      .prepare(`SELECT persona, xp, level, title, updated_at FROM agent_progress ORDER BY persona`)
      .all() as Array<{
      persona: string;
      xp: number;
      level: number;
      title: string;
      updated_at: number;
    }>;
    expect(rows).toHaveLength(2);
    const installer = rows.find((r) => r.persona === "installer")!;
    expect(installer.xp).toBe(150);
    expect(installer.level).toBe(levelFromXp(150));
    expect(installer.title).toBe(titleFor("installer", installer.level));
    expect(installer.updated_at).toBe(2000);

    expect(migrateAgentProgressToGlobal(raw)).toBe(false);
  });
});
