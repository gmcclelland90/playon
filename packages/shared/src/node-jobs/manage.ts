import { z } from "zod";
import { defineNodeJob, type NodeJobContractMap } from "./contract.js";
import { NodeJailPathSchema } from "./fs.js";

/**
 * Manage job kinds — adopting a game server that already exists on a node.
 *
 * This family is the one that reaches outside the jail: the install being adopted
 * lives wherever its operator put it, so `sourcePath` / `roots` / `allowRoots` are
 * host paths and the node — not this schema — decides whether one is in bounds
 * (`assertPackPathAllowed`). Roots may still be `~`, `$HOME`, or glob patterns at
 * this point; they are expanded on the node that owns the filesystem.
 *
 * Everything the copy *writes* stays jail-relative and is pinned here to the
 * server's own directories, so a mistyped destination fails on the control plane
 * before a job is queued.
 *
 * Args are strict (a typo must fail loudly); results are lenient about extra
 * fields so a newer agent can add them without breaking an older control plane.
 */

/** Where `manage_pack` stages archives, jail-relative to the node data root. */
export const MANAGE_PACK_STAGING_REL = "tmp/manage-packs";

/** Largest chunk `manage_pack_read` will return in one call. */
export const MANAGE_PACK_READ_MAX_BYTES = 16 * 1024 * 1024;

/** Default archive ceiling: packs stage on the data disk, not a small `/tmp`. */
export const MANAGE_PACK_MAX_BYTES = 32 * 1024 * 1024 * 1024;

/** An absolute-or-pattern path on the node host; resolved and allowlisted there. */
const HostPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"), { message: "must not contain a NUL byte" });

/** Roots the node may scan or copy from; empty would mean "anything", so never empty. */
const HostRootsSchema = z.array(HostPathSchema).min(1);

/** Manage only ever writes into the adopted server's own dirs. */
function serverDirSchema(leaf: "game" | "home") {
  const shape = new RegExp(`^servers/[^/]+/${leaf}$`);
  return NodeJailPathSchema.refine((value) => shape.test(value.replace(/\\/g, "/")), {
    message: `must be servers/<serverId>/${leaf}`,
  });
}

/** Per-game cutover hints: external userdata + launch args beyond the install tree. */
export const ImportHintManageSchema = z.object({
  /** Dirs under the service user home (e.g. "Zomboid"). */
  userdataHomeDirs: z.array(z.string().min(1)).default([]),
  /** CLI flag name without leading dashes (e.g. "servername"). */
  serverNameArg: z.string().min(1).optional(),
  /** When true, Manage supplies a non-interactive -adminpassword. */
  adminPasswordArg: z.boolean().default(false),
  /** Subdirs under userdata used for world-selective copy. */
  worldSubdirs: z.array(z.string().min(1)).default(["Server", "db", "Saves/Multiplayer"]),
});

export type ImportHintManage = z.infer<typeof ImportHintManageSchema>;

/** Fingerprint rule shipped to the node in `manage_probe` args. */
export const ImportHintRuleSchema = z.object({
  id: z.string().min(1),
  anyFiles: z.array(z.string().min(1)).default([]),
  suggestedGame: z.string().optional(),
  suggestedSkillName: z.string().optional(),
  manage: ImportHintManageSchema.optional(),
});

export type ImportHintRule = z.infer<typeof ImportHintRuleSchema>;

export const ImportProbeCandidateSchema = z.object({
  path: z.string().min(1),
  hintIds: z.array(z.string()),
  suggestedGame: z.string().optional(),
  suggestedSkillName: z.string().optional(),
});

export type ImportProbeCandidate = z.infer<typeof ImportProbeCandidateSchema>;

export const ManageProbeArgsSchema = z
  .object({
    roots: HostRootsSchema,
    hints: z.array(ImportHintRuleSchema).default([]),
    maxDepth: z.number().int().min(0).max(4).default(2),
    maxCandidates: z.number().int().min(1).max(100).default(40),
  })
  .strict();

export const ManageProbeResultSchema = z.object({
  candidates: z.array(ImportProbeCandidateSchema),
  scannedRoots: z.array(z.string()),
});

export const ManagePackArgsSchema = z
  .object({
    path: HostPathSchema,
    /** Roots that are allowed as pack sources (expanded on the node). */
    allowRoots: HostRootsSchema,
    maxBytes: z.number().int().positive().default(MANAGE_PACK_MAX_BYTES),
  })
  .strict();

/** The pack lands under the node data root; Home pulls it via `manage_pack_read`. */
export const ManagePackResultSchema = z.object({
  packRel: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  /** Absolute source path the node packed. */
  path: z.string(),
});

export const ManagePackReadArgsSchema = z
  .object({
    packRel: NodeJailPathSchema.refine(
      (value) => value.replace(/\\/g, "/").startsWith(`${MANAGE_PACK_STAGING_REL}/`),
      { message: `must be a pack under ${MANAGE_PACK_STAGING_REL}/` },
    ),
    offset: z.number().int().nonnegative(),
    length: z
      .number()
      .int()
      .positive()
      .max(MANAGE_PACK_READ_MAX_BYTES)
      .default(4 * 1024 * 1024),
  })
  .strict();

export const ManagePackReadResultSchema = z.object({
  dataBase64: z.string(),
  bytes: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  done: z.boolean(),
});

/** Copy an allowlisted install into the node's PlayOn server jail (no Home transfer). */
export const ManageSeedArgsSchema = z
  .object({
    sourcePath: HostPathSchema,
    allowRoots: HostRootsSchema,
    destRel: serverDirSchema("game"),
  })
  .strict();

export const ManageSeedResultSchema = z.object({
  destRel: z.string(),
  sourcePath: z.string(),
  bytesCopied: z.number().int().nonnegative(),
});

/** After seed: sniff systemd + copy external userdata into servers/<id>/home. */
export const ManageCutoverArgsSchema = z
  .object({
    sourcePath: HostPathSchema,
    allowRoots: HostRootsSchema,
    homeRel: serverDirSchema("home"),
    manage: ImportHintManageSchema,
  })
  .strict();

export const ManageCutoverResultSchema = z.object({
  serverName: z.string().optional(),
  unitName: z.string().optional(),
  /** Absolute HOME path on the node for Start (servers/<id>/home). */
  playonHome: z.string().min(1),
  playonHomeRel: z.string().min(1),
  userdataBytes: z.number().int().nonnegative(),
  warnings: z.array(z.string()).default([]),
});

export const MANAGE_NODE_JOB_CONTRACTS = {
  manage_probe: defineNodeJob("manage_probe", ManageProbeArgsSchema, ManageProbeResultSchema),
  manage_pack: defineNodeJob("manage_pack", ManagePackArgsSchema, ManagePackResultSchema),
  manage_pack_read: defineNodeJob(
    "manage_pack_read",
    ManagePackReadArgsSchema,
    ManagePackReadResultSchema,
  ),
  manage_seed: defineNodeJob("manage_seed", ManageSeedArgsSchema, ManageSeedResultSchema),
  manage_cutover: defineNodeJob(
    "manage_cutover",
    ManageCutoverArgsSchema,
    ManageCutoverResultSchema,
  ),
} as const satisfies NodeJobContractMap;

export type ManageProbeArgs = z.infer<typeof ManageProbeArgsSchema>;
export type ManageProbeResult = z.infer<typeof ManageProbeResultSchema>;
export type ManagePackArgs = z.infer<typeof ManagePackArgsSchema>;
export type ManagePackResult = z.infer<typeof ManagePackResultSchema>;
export type ManagePackReadArgs = z.infer<typeof ManagePackReadArgsSchema>;
export type ManagePackReadResult = z.infer<typeof ManagePackReadResultSchema>;
export type ManageSeedArgs = z.infer<typeof ManageSeedArgsSchema>;
export type ManageSeedResult = z.infer<typeof ManageSeedResultSchema>;
export type ManageCutoverArgs = z.infer<typeof ManageCutoverArgsSchema>;
export type ManageCutoverResult = z.infer<typeof ManageCutoverResultSchema>;
