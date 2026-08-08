import { z } from "zod";

/**
 * Request contracts for the snapshot and off-node backup routes. They live here
 * rather than inline in `app.ts` so the control plane and web client validate
 * the same shape, and so a schema failure renders as the shared 400 envelope.
 */

const nonEmpty = z.string().min(1);

export const CreateSnapshotRequestSchema = z.object({
  serverId: nonEmpty,
  label: nonEmpty.optional(),
});

export type CreateSnapshotRequest = z.infer<typeof CreateSnapshotRequestSchema>;

export const BackupTargetRequestSchema = z.object({
  rootPath: nonEmpty,
});

export type BackupTargetRequest = z.infer<typeof BackupTargetRequestSchema>;

/**
 * Either identifier is enough: a `snapshotId` exports an existing snapshot, a
 * `serverId` takes a fresh one first. The route still rejects a body with
 * neither, so the caller keeps the `serverId_or_snapshotId_required` text
 * instead of a generic schema failure.
 */
export const CreateOffNodeBackupRequestSchema = z.object({
  serverId: nonEmpty.optional(),
  snapshotId: nonEmpty.optional(),
  label: nonEmpty.optional(),
});

export type CreateOffNodeBackupRequest = z.infer<typeof CreateOffNodeBackupRequestSchema>;

/** Omitting `serverId` restores the backup over the server it came from. */
export const RestoreOffNodeBackupRequestSchema = z.object({
  serverId: nonEmpty.optional(),
});

export type RestoreOffNodeBackupRequest = z.infer<typeof RestoreOffNodeBackupRequestSchema>;
