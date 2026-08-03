import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { loadConfig } from "../config.js";

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

function ensureNodeCapabilityColumns(raw: Database.Database) {
  const cols = raw.prepare(`PRAGMA table_info(nodes)`).all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("native")) {
    raw.exec(`ALTER TABLE nodes ADD COLUMN native INTEGER NOT NULL DEFAULT 1`);
  }
  if (!names.has("steamcmd")) {
    raw.exec(`ALTER TABLE nodes ADD COLUMN steamcmd INTEGER NOT NULL DEFAULT 0`);
  }
}

/** Dev reset: replace legacy persona/per-server progress with skill-keyed table. */
function ensureAgentProgressSkillTable(raw: Database.Database) {
  const cols = raw.prepare(`PRAGMA table_info(agent_progress)`).all() as Array<{ name: string }>;
  if (!cols.length) return;
  const names = new Set(cols.map((c) => c.name));
  if (names.has("skill") && !names.has("persona") && !names.has("server_id")) return;
  raw.exec(`DROP TABLE agent_progress`);
  raw.exec(`
    CREATE TABLE agent_progress (
      skill TEXT NOT NULL PRIMARY KEY,
      xp INTEGER NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 1,
      title TEXT NOT NULL DEFAULT 'Rookie',
      updated_at INTEGER NOT NULL
    )
  `);
}

function ensureAccessTokensTable(raw: Database.Database) {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS access_tokens (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id),
      auto_approve_confirms INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at INTEGER
    )
  `);
}

export function applyBootstrap(dbPath: string) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sql = fs.readFileSync(resolveBootstrapSql(), "utf8");
  const raw = new Database(dbPath);
  raw.exec(sql);
  ensureConversationColumns(raw);
  ensureNodeCapabilityColumns(raw);
  ensureAgentProgressSkillTable(raw);
  ensureAccessTokensTable(raw);
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
