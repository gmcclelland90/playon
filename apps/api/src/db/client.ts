import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { redactSql } from "./sqlite-error.js";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: Db;
  sqlite: Database.Database;
}

/** Last statement shape, for process-level FK logs. Literals are redacted. */
let lastSqliteStatement: string | null = null;

export function recentSqliteStatement(): string | null {
  return lastSqliteStatement;
}

export function noteSqliteStatement(sql: string): void {
  lastSqliteStatement = redactSql(sql);
}

export function createDb(dbPath: string): DbHandle {
  const sqlite = new Database(dbPath, {
    verbose: (sql) => {
      noteSqliteStatement(String(sql));
    },
  });
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}
