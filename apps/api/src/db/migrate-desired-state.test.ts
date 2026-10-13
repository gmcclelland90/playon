import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyBootstrap } from "./migrate.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("desired_state migration (#1038)", () => {
  it("adds columns and backfills running only when instance_started_at is set", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-migrate-desired-"));
    temps.push(root);
    const dbPath = path.join(root, "playon.sqlite");
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        game TEXT,
        node_id TEXT,
        runtime_mode TEXT NOT NULL DEFAULT 'docker',
        status TEXT NOT NULL DEFAULT 'stopped',
        data_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        instance_started_at INTEGER
      );
    `);
    raw
      .prepare(
        `INSERT INTO servers (id, name, game, runtime_mode, status, data_path, created_at, instance_started_at)
         VALUES (?, ?, ?, 'native', ?, ?, ?, ?)`,
      )
      .run("alive", "Paper", "Paper", "stopped", "/tmp/a", Date.now(), Date.now());
    raw
      .prepare(
        `INSERT INTO servers (id, name, game, runtime_mode, status, data_path, created_at, instance_started_at)
         VALUES (?, ?, ?, 'native', ?, ?, ?, ?)`,
      )
      .run("stale", "Hub", "Project Zomboid", "running", "/tmp/b", Date.now(), null);
    raw.close();

    applyBootstrap(dbPath);
    const next = new Database(dbPath);
    const cols = next.prepare(`PRAGMA table_info(servers)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("desired_state")).toBe(true);
    expect(names.has("auto_start")).toBe(true);
    const rows = next
      .prepare(`SELECT id, desired_state, auto_start FROM servers ORDER BY id`)
      .all() as Array<{ id: string; desired_state: string; auto_start: number }>;
    expect(rows).toEqual([
      { id: "alive", desired_state: "running", auto_start: 1 },
      { id: "stale", desired_state: "stopped", auto_start: 1 },
    ]);
    next.close();
  });
});
