import { z } from "zod";

/**
 * Request contracts for the mutating server routes. They live here rather than
 * inline in `app.ts` so the control plane and web client validate the same
 * shape, and so a schema failure renders as the shared 400 envelope.
 */

const optionalName = z.string().min(1).optional();

export const ImportLocalServerRequestSchema = z.object({
  sourcePath: z.string().min(1),
  serverName: optionalName,
  skillName: optionalName,
  game: optionalName,
  nodeId: optionalName,
});

export type ImportLocalServerRequest = z.infer<typeof ImportLocalServerRequestSchema>;

/** `password` / `privateKey` are credentials: never log or echo a parsed body. */
export const ImportSftpServerRequestSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().optional(),
  username: z.string().min(1),
  password: optionalName,
  privateKey: optionalName,
  remotePath: z.string().min(1),
  serverName: optionalName,
  skillName: optionalName,
  game: optionalName,
  nodeId: optionalName,
});

export type ImportSftpServerRequest = z.infer<typeof ImportSftpServerRequestSchema>;

export const RelocateServerRequestSchema = z.object({
  targetNodeId: z.string().min(1),
});

export type RelocateServerRequest = z.infer<typeof RelocateServerRequestSchema>;

/** Display name only — must not be used to rename ids, data dirs, or world folders. */
export const SERVER_DISPLAY_NAME_MAX = 80;

export const RenameServerRequestSchema = z.object({
  name: z.string().trim().min(1).max(SERVER_DISPLAY_NAME_MAX),
});

export type RenameServerRequest = z.infer<typeof RenameServerRequestSchema>;

/** PUT `/api/servers/:id/fs/content` — path + full text body. */
export const WriteServerFsContentRequestSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export type WriteServerFsContentRequest = z.infer<typeof WriteServerFsContentRequestSchema>;
