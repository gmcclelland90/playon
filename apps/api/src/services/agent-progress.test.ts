import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { AgentProgressService, levelFromXp, titleFor, xpProgressInLevel } from "./agent-progress.js";

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

  it("titles reflect level bands and skill labels", () => {
    expect(titleFor("installer", 1)).toBe("Rookie Install");
    expect(titleFor("backup", 5)).toBe("Operator Backup");
    expect(titleFor("troubleshooter", 12)).toBe("Legend Fix");
  });

  it("tracks XP within the current level", () => {
    const atZero = xpProgressInLevel(0);
    expect(atZero.level).toBe(1);
    expect(atZero.intoLevel).toBe(0);
    expect(atZero.need).toBe(100);

    const mid = xpProgressInLevel(50);
    expect(mid.level).toBe(1);
    expect(mid.intoLevel).toBe(50);

    const leveled = xpProgressInLevel(100);
    expect(leveled.level).toBe(2);
    expect(leveled.intoLevel).toBe(0);
  });
});

describe("global agent skill progress", () => {
  it("awards XP against a host-wide skill row", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-agent-xp-"));
    const dbPath = path.join(root, "playon.db");
    applyBootstrap(dbPath);
    const { db, sqlite } = createDb(dbPath);
    temps.push({ root, sqlite });

    const progress = new AgentProgressService(db);
    const first = await progress.award("installer", 50, "clean_install");
    expect(first.progress.xp).toBe(50);
    expect(first.progress.skill).toBe("installer");
    expect(first.progress.title).toBe("Rookie Install");

    const second = await progress.award("installer", 60, "server_start");
    expect(second.progress.xp).toBe(110);
    expect(second.leveledUp).toBe(true);

    const skills = await progress.listSkills();
    const installer = skills.find((a) => a.skill === "installer");
    expect(installer?.xp).toBe(110);
    expect(skills).toHaveLength(8);
  });

  it("awardForTools maps tools to skills and skips failures", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-agent-tools-"));
    const dbPath = path.join(root, "playon.db");
    applyBootstrap(dbPath);
    const { db, sqlite } = createDb(dbPath);
    temps.push({ root, sqlite });

    const progress = new AgentProgressService(db);
    const awards = await progress.awardForTools([
      { name: "servers_start", result: { ok: true } },
      { name: "servers_start", result: { error: "boom" } },
      { name: "panel_publish", result: { ok: true } },
    ]);
    expect(awards).toHaveLength(2);
    expect(awards[0]!.skill).toBe("installer");
    expect(awards[0]!.progress.xp).toBe(15);
    expect(awards[1]!.skill).toBe("player_panel");
    expect(awards[1]!.progress.xp).toBe(10);
  });
});
