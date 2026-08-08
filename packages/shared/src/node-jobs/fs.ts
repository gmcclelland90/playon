import { z } from "zod";
import { defineNodeJob, type NodeJobContractMap } from "./contract.js";

/**
 * Filesystem job kinds. Every path is relative to the node's data root and the
 * agent resolves it inside the path jail; the schema rejects the shapes that
 * could only ever be an escape attempt, so a bad path fails on the control
 * plane before a job is ever queued.
 *
 * Args are strict (a typo must fail loudly); results are lenient about extra
 * fields so a newer agent can add them without breaking an older control plane.
 */

/** Largest slice `fs_read_text` will return in one call; the agent clamps to it. */
export const FS_READ_MAX_BYTES = 512_000;

function isJailRelative(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return false;
  if (/^[a-zA-Z]:/.test(normalized)) return false;
  if (normalized.includes("\0")) return false;
  return !normalized.split("/").includes("..");
}

export const NodeJailPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(isJailRelative, { message: "must be a jail-relative path (no leading / or .. segment)" });

const FsEntrySchema = z.object({
  name: z.string().min(1),
  type: z.enum(["file", "dir"]),
});

export const FsListArgsSchema = z
  .object({
    path: NodeJailPathSchema.default("."),
  })
  .strict();

export const FsListResultSchema = z.object({
  path: z.string(),
  entries: z.array(FsEntrySchema),
});

export const FsReadTextArgsSchema = z
  .object({
    path: NodeJailPathSchema,
    offset: z.number().int().min(0).default(0),
    /** Absent means "as much as the agent allows" (`FS_READ_MAX_BYTES`). */
    maxBytes: z.number().int().positive().optional(),
  })
  .strict();

export const FsReadTextResultSchema = z.object({
  path: z.string(),
  content: z.string(),
  bytesRead: z.number().int().min(0),
  /** More bytes exist past `offset + bytesRead`; read again to continue. */
  truncated: z.boolean(),
  size: z.number().int().min(0),
});

export const FsWriteTextArgsSchema = z
  .object({
    path: NodeJailPathSchema,
    content: z.string().default(""),
  })
  .strict();

export const FsWriteTextResultSchema = z.object({
  path: z.string(),
  bytes: z.number().int().min(0),
});

export const FsEnsureDirArgsSchema = z
  .object({
    path: NodeJailPathSchema,
  })
  .strict();

export const FsEnsureDirResultSchema = z.object({
  path: z.string(),
  ok: z.boolean(),
});

export const FsRemoveArgsSchema = z
  .object({
    path: NodeJailPathSchema,
  })
  .strict();

export const FsRemoveResultSchema = z.object({
  path: z.string(),
  ok: z.boolean(),
});

const FsMoveArgsShape = {
  from: NodeJailPathSchema,
  to: NodeJailPathSchema,
  overwrite: z.boolean().default(false),
};

const FsMoveResultShape = {
  from: z.string(),
  to: z.string(),
};

export const FsRenameArgsSchema = z.object(FsMoveArgsShape).strict();
export const FsRenameResultSchema = z.object(FsMoveResultShape);

export const FsCopyArgsSchema = z.object(FsMoveArgsShape).strict();
export const FsCopyResultSchema = z.object(FsMoveResultShape);

/** Only `tar` travels today; naming it keeps the wire self-describing. */
export const NodeArchiveFormatSchema = z.literal("tar").default("tar");

export const FsPutArchiveArgsSchema = z
  .object({
    path: NodeJailPathSchema,
    /** Empty base64 means "create the directory, leave it empty". */
    archiveBase64: z.string().default(""),
    format: NodeArchiveFormatSchema,
  })
  .strict();

export const FsPutArchiveResultSchema = z.object({
  path: z.string(),
  ok: z.boolean(),
});

export const FsGetArchiveArgsSchema = z
  .object({
    path: NodeJailPathSchema,
    format: NodeArchiveFormatSchema,
  })
  .strict();

export const FsGetArchiveResultSchema = z.object({
  /** Empty when the path does not exist on the node. */
  archiveBase64: z.string(),
});

export const FS_NODE_JOB_CONTRACTS = {
  fs_list: defineNodeJob("fs_list", FsListArgsSchema, FsListResultSchema),
  fs_read_text: defineNodeJob("fs_read_text", FsReadTextArgsSchema, FsReadTextResultSchema),
  fs_write_text: defineNodeJob("fs_write_text", FsWriteTextArgsSchema, FsWriteTextResultSchema),
  fs_ensure_dir: defineNodeJob("fs_ensure_dir", FsEnsureDirArgsSchema, FsEnsureDirResultSchema),
  fs_remove: defineNodeJob("fs_remove", FsRemoveArgsSchema, FsRemoveResultSchema),
  fs_rename: defineNodeJob("fs_rename", FsRenameArgsSchema, FsRenameResultSchema),
  fs_copy: defineNodeJob("fs_copy", FsCopyArgsSchema, FsCopyResultSchema),
  fs_put_archive: defineNodeJob("fs_put_archive", FsPutArchiveArgsSchema, FsPutArchiveResultSchema),
  fs_get_archive: defineNodeJob("fs_get_archive", FsGetArchiveArgsSchema, FsGetArchiveResultSchema),
} as const satisfies NodeJobContractMap;

export type FsEntry = z.infer<typeof FsEntrySchema>;
export type FsListResult = z.infer<typeof FsListResultSchema>;
export type FsReadTextResult = z.infer<typeof FsReadTextResultSchema>;
export type FsWriteTextResult = z.infer<typeof FsWriteTextResultSchema>;
export type FsGetArchiveResult = z.infer<typeof FsGetArchiveResultSchema>;
