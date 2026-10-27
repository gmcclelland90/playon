/**
 * Process-level last resort for errors that escape route handlers (#1045).
 * A foreign-key insert used to reject an un-awaited promise, Node treated that
 * as fatal, and systemd then SIGKILLed every native game in the cgroup.
 */
import { recentSqliteStatement } from "./db/client.js";
import { formatSqliteFailure, isSqliteForeignKeyError } from "./db/sqlite-error.js";

export type ProcessErrorEvent = "unhandledRejection" | "uncaughtException";

export interface ProcessErrorTarget {
  on(event: ProcessErrorEvent, handler: (reason: unknown) => void): void;
}

export function formatProcessFailure(event: ProcessErrorEvent | string, err: unknown): string {
  const sqlite = formatSqliteFailure(err, recentSqliteStatement());
  return JSON.stringify({ ...sqlite, msg: "playon_process_error", event });
}

/**
 * Log every unhandled rejection / uncaught exception with SQLite context.
 * Foreign-key failures are contained (the insert sites also catch them) so a
 * stray drizzle insert cannot exit the API and take native games with it.
 * Any other uncaught exception still exits after the log line.
 */
export function installProcessErrorHandlers(
  target: ProcessErrorTarget = process,
  log: (line: string) => void = (line) => console.error(line),
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  target.on("unhandledRejection", (reason) => {
    log(formatProcessFailure("unhandledRejection", reason));
  });
  target.on("uncaughtException", (err) => {
    log(formatProcessFailure("uncaughtException", err));
    if (!isSqliteForeignKeyError(err)) exit(1);
  });
}
