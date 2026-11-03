/**
 * Shape of a better-sqlite3 / drizzle failure, plus a redacted SQL hint.
 * Used when an insert violates a foreign key (#1045) so the log names the
 * statement without dumping bound secret values.
 */

export type SqliteErrorLike = {
  name?: string;
  code?: string;
  message?: string;
};

export function asSqliteError(err: unknown): SqliteErrorLike | null {
  if (!err || typeof err !== "object") return null;
  const rec = err as SqliteErrorLike & { name?: string };
  const message = typeof rec.message === "string" ? rec.message : "";
  const code = typeof rec.code === "string" ? rec.code : "";
  const name = typeof rec.name === "string" ? rec.name : "";
  if (name === "SqliteError" || code.startsWith("SQLITE_") || /SQLITE_|FOREIGN KEY/i.test(message)) {
    return { name, code, message };
  }
  return null;
}

export function isSqliteForeignKeyError(err: unknown): boolean {
  const sqlite = asSqliteError(err);
  if (!sqlite) return false;
  if (sqlite.code === "SQLITE_CONSTRAINT_FOREIGNKEY") return true;
  return /FOREIGN KEY constraint failed/i.test(sqlite.message ?? "");
}

/** Keep the statement shape; replace quoted literals so secrets stay out of logs. */
export function redactSql(sql: string): string {
  const compact = sql.replace(/\s+/g, " ").trim().slice(0, 400);
  return compact
    .replace(/'[^']*'/g, "'…'")
    .replace(/"[^"]*"/g, '"…"');
}

export function formatSqliteFailure(err: unknown, sql?: string | null): Record<string, unknown> {
  const sqlite = asSqliteError(err);
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && err.stack ? err.stack.split("\n").slice(0, 8).join("\n") : undefined;
  return {
    msg: "playon_sqlite_error",
    name: sqlite?.name ?? (err instanceof Error ? err.name : "Error"),
    code: sqlite?.code ?? null,
    foreignKey: isSqliteForeignKeyError(err),
    message,
    ...(sql ? { sql: redactSql(sql) } : {}),
    ...(stack ? { stack } : {}),
  };
}
