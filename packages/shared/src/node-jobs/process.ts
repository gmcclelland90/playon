import { z } from "zod";
import { defineNodeJob, type NodeJobContractMap } from "./contract.js";
import { NodeJailPathSchema } from "./fs.js";

/**
 * Process job kinds — the native half of the node seam. A process is addressed by
 * the supervisor id minted by `process_start`; that id lives only in the agent's
 * memory, so the control plane also passes `name` + `cwd` on stop and lets the
 * agent reclaim OS orphans when the id was lost to a restart on either shore.
 *
 * Args are strict (a typo must fail loudly); results are lenient about extra
 * fields so a newer agent can add them without breaking an older control plane.
 */

/** Supervisor id (e.g. `native-server-abc-1`), opaque to the control plane. */
export const ProcessIdSchema = z.string().min(1).max(256);

/** Supervisor process name; the control plane uses `server-<serverId>`. */
const ProcessNameSchema = z.string().min(1).max(256);

/**
 * `serverId` only tells the agent whose console to follow; a job without one
 * still starts or stops the process, it just streams no logs.
 */
const ProcessServerIdSchema = z.string().min(1).optional();

export const ProcessStatusValueSchema = z.enum(["running", "stopped", "unknown"]);

/** What `process_start` and `process_status` both report back. */
export const ProcessInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  /** Absent once the process has exited, or when the spawn produced no pid. */
  pid: z.number().int().positive().optional(),
  status: ProcessStatusValueSchema,
});

export const ProcessStartArgsSchema = z
  .object({
    name: ProcessNameSchema,
    /** Interpreter or binary — resolved by the OS, not inside the jail. */
    command: z.string().min(1).max(4096),
    args: z.array(z.string()).default([]),
    /** Working directory, jail-relative; defaults to the node data root itself. */
    cwd: NodeJailPathSchema.default("."),
    env: z.record(z.string(), z.string()).default({}),
    serverId: ProcessServerIdSchema,
    /** Console log sink, jail-relative. Also what a `serverId` follow tails. */
    logRel: NodeJailPathSchema.optional(),
  })
  .strict();

export const ProcessStartResultSchema = ProcessInfoSchema;

export const ProcessStopArgsSchema = z
  .object({
    /**
     * Empty when the tracked id was lost (API or node-agent restart) — the agent
     * then falls back to reclaiming by `name` + `cwd`.
     */
    id: z.string().max(256).default(""),
    name: z.string().max(256).default(""),
    /** Jail-relative dir whose OS orphans may be killed; absent skips reclaim. */
    cwd: NodeJailPathSchema.optional(),
    serverId: ProcessServerIdSchema,
  })
  .strict();

/** Stop acknowledges rather than describes; the state comes from `process_status`. */
export const ProcessStopResultSchema = z.object({
  ok: z.boolean(),
});

export const ProcessStatusArgsSchema = z
  .object({
    id: ProcessIdSchema,
  })
  .strict();

export const ProcessStatusResultSchema = ProcessInfoSchema;

export const PROCESS_NODE_JOB_CONTRACTS = {
  process_start: defineNodeJob("process_start", ProcessStartArgsSchema, ProcessStartResultSchema),
  process_stop: defineNodeJob("process_stop", ProcessStopArgsSchema, ProcessStopResultSchema),
  process_status: defineNodeJob(
    "process_status",
    ProcessStatusArgsSchema,
    ProcessStatusResultSchema,
  ),
} as const satisfies NodeJobContractMap;

export type ProcessStatusValue = z.infer<typeof ProcessStatusValueSchema>;
export type ProcessInfoResult = z.infer<typeof ProcessInfoSchema>;
export type ProcessStartArgs = z.infer<typeof ProcessStartArgsSchema>;
export type ProcessStopArgs = z.infer<typeof ProcessStopArgsSchema>;
