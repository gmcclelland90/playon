import { describe, expect, it } from "vitest";
import {
  BackupTargetRequestSchema,
  CreateOffNodeBackupRequestSchema,
  CreateSnapshotRequestSchema,
  RestoreOffNodeBackupRequestSchema,
} from "./snapshots.js";

describe("snapshot and backup route request contracts", () => {
  it("requires a server to snapshot and defaults the label at the route", () => {
    const result = CreateSnapshotRequestSchema.safeParse({ label: "pre-update" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual(["serverId"]);

    expect(CreateSnapshotRequestSchema.parse({ serverId: "srv-1" })).toEqual({
      serverId: "srv-1",
    });
  });

  it("requires a backup root path", () => {
    expect(BackupTargetRequestSchema.safeParse({ rootPath: "" }).success).toBe(false);
    expect(BackupTargetRequestSchema.parse({ rootPath: "/mnt/backups" })).toEqual({
      rootPath: "/mnt/backups",
    });
  });

  it("leaves the server-or-snapshot choice to the route", () => {
    // Both fields are optional here; the route answers
    // `serverId_or_snapshotId_required` so callers keep that text.
    expect(CreateOffNodeBackupRequestSchema.safeParse({}).success).toBe(true);
    expect(CreateOffNodeBackupRequestSchema.parse({ snapshotId: "snap-1" }).snapshotId).toBe(
      "snap-1",
    );
  });

  it("treats an empty restore body as restoring onto the original server", () => {
    expect(RestoreOffNodeBackupRequestSchema.parse({})).toEqual({});
    expect(RestoreOffNodeBackupRequestSchema.safeParse({ serverId: "" }).success).toBe(false);
  });
});
