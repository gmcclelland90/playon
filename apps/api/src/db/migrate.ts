import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { loadConfig } from "../config.js";
import { levelFromXp, titleFor } from "../services/agent-progress.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveBootstrapSql(): string {
  const candidates = [
    path.join(__dirname, "bootstrap.sql"),
    path.join(__dirname, "../../src/db/bootstrap.sql"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`bootstrap.sql not found near ${__dirname}`);
}

function ensureConversationColumns(raw: Database.Database) {
  const cols = raw.prepare(`PRAGMA table_info(conversations)`).all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("server_id")) {
    raw.exec(`ALTER TABLE conversations ADD COLUMN server_id TEXT REFERENCES servers(id)`);
  }
  if (!names.has("updated_at")) {
    raw.exec(`ALTER TABLE conversations ADD COLUMN updated_at INTEGER`);
    raw.exec(`UPDATE conversations SET updated_at = created_at WHERE updated_at IS NULL`);
  }
}

type LegacyProgressRow = {
  persona: string;
  xp: number;
  updated_at: number;
};

/** Merge per-server agent_progress into global persona rows (sum XP). */
export function migrateAgentProgressToGlobal(raw: Database.Database): boolean {
  const cols = raw.prepare(`PRAGMA table_info(agent_progress)`).all() as Array<{ name: string }>;
  if (!cols.length) return false;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("server_id")) return false;

  const legacy = raw
    .prepare(`SELECT persona, xp, updated_at FROM agent_progress`)
    .all() as LegacyProgressRow[];

  const merged = new Map<string, { xp: number; updatedAt: number }>();
  for (const row of legacy) {
    const prev = merged.get(row.persona);
    if (!prev) {
      merged.set(row.persona, { xp: row.xp, updatedAt: row.updated_at });
    } else {
      merged.set(row.persona, {
        xp: prev.xp + row.xp,
        updatedAt: Math.max(prev.updatedAt, row.updated_at),
      });
    }
  }

  raw.exec(`DROP TABLE IF EXISTS agent_progress_new`);
  raw.exec(`
    CREATE TABLE agent_progress_new (
      persona TEXT NOT NULL PRIMARY KEY,
      xp INTEGER NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 1,
      title TEXT NOT NULL DEFAULT 'Rookie',
      updated_at INTEGER NOT NULL
    )
  `);

  const insert = raw.prepare(
    `INSERT INTO agent_progress_new (persona, xp, level, title, updated_at) VALUES (?, ?, ?, ?, ?)`,
  );
  const tx = raw.transaction(() => {
    for (const [persona, { xp, updatedAt }] of merged) {
      const level = levelFromXp(xp);
      insert.run(persona, xp, level, titleFor(persona, level), updatedAt);
    }
  });
  tx();

  raw.exec(`DROP TABLE agent_progress`);
  raw.exec(`ALTER TABLE agent_progress_new RENAME TO agent_progress`);
  return true;
}

export function applyBootstrap(dbPath: string) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sql = fs.readFileSync(resolveBootstrapSql(), "utf8");
  const raw = new Database(dbPath);
  raw.exec(sql);
  ensureConversationColumns(raw);
  migrateAgentProgressToGlobal(raw);
  raw.close();
}


const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).includes(`${path.sep}migrate.`);

if (isMain) {
  const config = loadConfig();
  applyBootstrap(config.dbPath);
  console.log(`Migrated ${config.dbPath}`);
}
