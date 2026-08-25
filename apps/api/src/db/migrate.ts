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
  if (!names.has("kind")) {
    raw.exec(`ALTER TABLE nodes ADD COLUMN kind TEXT NOT NULL DEFAULT 'lan'`);
    raw.exec(`UPDATE nodes SET kind = 'local' WHERE id = 'local'`);
  }
  if (!names.has("wg_public_key")) {
    raw.exec(`ALTER TABLE nodes ADD COLUMN wg_public_key TEXT`);
  }
  if (!names.has("wg_private_key_encrypted")) {
    raw.exec(`ALTER TABLE nodes ADD COLUMN wg_private_key_encrypted TEXT`);
  }
  if (!names.has("tunnel_endpoint")) {
    raw.exec(`ALTER TABLE nodes ADD COLUMN tunnel_endpoint TEXT`);
  }
  if (!names.has("overlay_ip")) {
    raw.exec(`ALTER TABLE nodes ADD COLUMN overlay_ip TEXT`);
  }
  if (!names.has("tunnel_status")) {
    raw.exec(`ALTER TABLE nodes ADD COLUMN tunnel_status TEXT NOT NULL DEFAULT 'none'`);
  }
  if (!names.has("join_host")) {
    raw.exec(`ALTER TABLE nodes ADD COLUMN join_host TEXT`);
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

function ensureServerInstanceStartedAt(raw: Database.Database) {
  const cols = raw.prepare(`PRAGMA table_info(servers)`).all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("instance_started_at")) {
    raw.exec(`ALTER TABLE servers ADD COLUMN instance_started_at INTEGER`);
  }
}

function ensureUserMfaColumns(raw: Database.Database) {
  const cols = raw.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("totp_secret_encrypted")) {
    raw.exec(`ALTER TABLE users ADD COLUMN totp_secret_encrypted TEXT`);
  }
  if (!names.has("totp_enabled")) {
    raw.exec(`ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0`);
  }
  if (!names.has("totp_enrolled_at")) {
    raw.exec(`ALTER TABLE users ADD COLUMN totp_enrolled_at INTEGER`);
  }
  if (!names.has("totp_last_step")) {
    raw.exec(`ALTER TABLE users ADD COLUMN totp_last_step INTEGER`);
  }
  if (!names.has("host_file_reset_enabled")) {
    raw.exec(`ALTER TABLE users ADD COLUMN host_file_reset_enabled INTEGER NOT NULL DEFAULT 1`);
  }
  if (!names.has("mfa_backup_hashes_json")) {
    raw.exec(`ALTER TABLE users ADD COLUMN mfa_backup_hashes_json TEXT`);
  }
}

function ensureMfaPendingTable(raw: Database.Database) {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS mfa_pending (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);
}

function ensureWatchersTables(raw: Database.Database) {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS watchers (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id),
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      trigger_json TEXT NOT NULL,
      action_json TEXT NOT NULL,
      cooldown_ms INTEGER NOT NULL DEFAULT 60000,
      debounce_ms INTEGER NOT NULL DEFAULT 0,
      confirm_mode TEXT NOT NULL DEFAULT 'auto',
      source TEXT NOT NULL DEFAULT 'user',
      skill_slug TEXT,
      last_fired_at INTEGER,
      next_due_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  raw.exec(`
    CREATE TABLE IF NOT EXISTS watcher_runs (
      id TEXT PRIMARY KEY,
      watcher_id TEXT NOT NULL REFERENCES watchers(id),
      server_id TEXT NOT NULL REFERENCES servers(id),
      status TEXT NOT NULL,
      trigger_payload_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT,
      error TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER
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
  ensureWatchersTables(raw);
  ensureServerInstanceStartedAt(raw);
  ensureUserMfaColumns(raw);
  ensureMfaPendingTable(raw);
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
