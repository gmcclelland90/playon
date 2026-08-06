import { z } from "zod";

/** Fingerprint rule shipped to node-agent in import_probe job args. */
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
  /** Max archive bytes before reject (default 512 MiB). */
  maxBytes: z.number().int().positive().default(512 * 1024 * 1024),
});

export type ImportPackArgs = z.infer<typeof ImportPackArgsSchema>;

export const ImportPackResultSchema = z.object({
  archiveBase64: z.string(),
  bytes: z.number().int().nonnegative(),
  path: z.string(),
});

export type ImportPackResult = z.infer<typeof ImportPackResultSchema>;
