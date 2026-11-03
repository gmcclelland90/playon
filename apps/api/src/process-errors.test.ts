import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { noteSqliteStatement, recentSqliteStatement } from "./db/client.js";
import { formatSqliteFailure, isSqliteForeignKeyError, redactSql } from "./db/sqlite-error.js";
import { formatProcessFailure, installProcessErrorHandlers } from "./process-errors.js";

describe("sqlite foreign-key logging (#1045)", () => {
  it("redacts quoted literals and recognises a foreign-key SqliteError", () => {
    expect(redactSql("insert into watcher_runs (id) values ('secret-token')  ")).toBe(
      "insert into watcher_runs (id) values ('…')",
    );
    const err = Object.assign(new Error("FOREIGN KEY constraint failed"), {
      name: "SqliteError",
      code: "SQLITE_CONSTRAINT_FOREIGNKEY",
    });
    expect(isSqliteForeignKeyError(err)).toBe(true);
    noteSqliteStatement("insert into snapshots values ('pw')");
    const body = formatSqliteFailure(err, recentSqliteStatement());
    expect(body.foreignKey).toBe(true);
    expect(body.sql).toBe("insert into snapshots values ('…')");
    expect(JSON.stringify(body)).not.toContain("pw");
  });
});

describe("installProcessErrorHandlers", () => {
  it("logs unhandled rejections and contains a foreign-key uncaught exception", () => {
    const target = new EventEmitter();
    const logs: string[] = [];
    const exits: number[] = [];
    installProcessErrorHandlers(
      target,
      (line) => logs.push(line),
      (code) => exits.push(code),
    );
    const fk = Object.assign(new Error("FOREIGN KEY constraint failed"), {
      name: "SqliteError",
      code: "SQLITE_CONSTRAINT_FOREIGNKEY",
    });
    target.emit("unhandledRejection", fk);
    target.emit("uncaughtException", fk);
    expect(exits).toEqual([]);
    expect(logs).toHaveLength(2);
    for (const line of logs) {
      const parsed = JSON.parse(line) as { msg: string; event: string; foreignKey: boolean };
      expect(parsed.msg).toBe("playon_process_error");
      expect(parsed.foreignKey).toBe(true);
    }
    expect(logs[0]).toContain("unhandledRejection");
    expect(logs[1]).toContain("uncaughtException");

    target.emit("uncaughtException", new Error("boom"));
    expect(exits).toEqual([1]);
    expect(formatProcessFailure("uncaughtException", new Error("boom"))).toContain("playon_process_error");
  });
});
