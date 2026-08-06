import { z } from "zod";

/** Fingerprint rule shipped to node-agent in manage_probe job args. */
export const ImportHintRuleSchema = z.object({
  id: z.string().min(1),
  anyFiles: z.array(z.string().min(1)).default([]),
  suggestedGame: z.string().optional(),
  suggestedSkillName: z.string().optional(),
});

export type ImportHintRule = z.infer<typeof ImportHintRuleSchema>;

export const ImportProbeCandidateSchema = z.object({
  path: z.string().min(1),
  hintIds: z.array(z.string()),
  suggestedGame: z.string().optional(),
  suggestedSkillName: z.string().optional(),
});

export type ImportProbeCandidate = z.infer<typeof ImportProbeCandidateSchema>;

export const ImportProbeArgsSchema = z.object({
  roots: z.array(z.string().min(1)).min(1),
  hints: z.array(ImportHintRuleSchema).default([]),
  maxDepth: z.number().int().min(0).max(4).default(2),
  maxCandidates: z.number().int().min(1).max(100).default(40),
});

export type ImportProbeArgs = z.infer<typeof ImportProbeArgsSchema>;

export const ImportProbeResultSchema = z.object({
  candidates: z.array(ImportProbeCandidateSchema),
  scannedRoots: z.array(z.string()),
});

export type ImportProbeResult = z.infer<typeof ImportProbeResultSchema>;

export const ImportPackArgsSchema = z.object({
  path: z.string().min(1),
  /** Absolute roots that are allowed as pack sources (expanded). */
  allowRoots: z.array(z.string().min(1)).min(1),
  /** Max archive bytes before reject (default 32 GiB — staged on data disk, not /tmp). */
  maxBytes: z.number().int().positive().default(32 * 1024 * 1024 * 1024),
});

export type ImportPackArgs = z.infer<typeof ImportPackArgsSchema>;

/** Pack lands under node dataRoot; Home pulls via manage_pack_read chunks. */
export const ImportPackResultSchema = z.object({
  packRel: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  path: z.string(),
});

export type ImportPackResult = z.infer<typeof ImportPackResultSchema>;

export const ManagePackReadArgsSchema = z.object({
  packRel: z.string().min(1),
  offset: z.number().int().nonnegative(),
  /** Max bytes to return in this chunk (default 4 MiB). */
  length: z.number().int().positive().max(16 * 1024 * 1024).default(4 * 1024 * 1024),
});

export type ManagePackReadArgs = z.infer<typeof ManagePackReadArgsSchema>;

export const ManagePackReadResultSchema = z.object({
  dataBase64: z.string(),
  bytes: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  done: z.boolean(),
});

export type ManagePackReadResult = z.infer<typeof ManagePackReadResultSchema>;

/** Copy an allowlisted install into the node's PlayOn server jail (no Home transfer). */
export const ManageSeedArgsSchema = z.object({
  sourcePath: z.string().min(1),
  allowRoots: z.array(z.string().min(1)).min(1),
  /** Relative to dataRoot, e.g. servers/<id>/game */
  destRel: z.string().min(1),
});

export type ManageSeedArgs = z.infer<typeof ManageSeedArgsSchema>;

export const ManageSeedResultSchema = z.object({
  destRel: z.string(),
  sourcePath: z.string(),
  bytesCopied: z.number().int().nonnegative(),
});

export type ManageSeedResult = z.infer<typeof ManageSeedResultSchema>;

/** Home-side marker: game files live on the node; do not push empty Home tree over them. */
export const NODE_AUTHORITATIVE_MARKER = ".playon-node-authoritative";
