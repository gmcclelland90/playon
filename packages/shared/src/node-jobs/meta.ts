import { z } from "zod";
import { NodeCapabilitiesSchema } from "../api.js";
import { defineNodeJob, type NodeJobContractMap } from "./contract.js";

/**
 * Meta job kinds — liveness, capability probing, and agent self-update.
 * Args are strict (a typo must fail loudly); results are lenient about extra
 * fields so a newer agent can add them without breaking an older control plane.
 */

export const PingArgsSchema = z.object({}).strict();

export const PingResultSchema = z.object({
  pong: z.boolean(),
  nodeId: z.string().min(1),
  dataRoot: z.string().min(1),
  at: z.string().min(1),
});

export const RuntimeCapsArgsSchema = z.object({}).strict();

export const RuntimeCapsResultSchema = NodeCapabilitiesSchema;

export const NodeSelfUpdateArgsSchema = z
  .object({
    downloadUrl: z.string().url(),
    sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
    version: z.string().min(1),
    /** Install-root entries kept across the tree swap (data dirs, env files). */
    preserve: z.array(z.string().min(1)).optional(),
    installRoot: z.string().min(1).optional(),
    /** Tests only: perform the swap but do not schedule the agent restart. */
    skipExit: z.boolean().optional(),
    /**
     * How Home is driving this job. `esm-bootstrap` is Home-tracked only: a 0.2.3/0.2.4
     * Windows agent must not claim it (those builds `require()` in ESM after extract).
     */
    via: z.enum(["agent", "esm-bootstrap"]).optional(),
  })
  .strict();

export const NodeSelfUpdateResultSchema = z.object({
  version: z.string().min(1),
  installRoot: z.string().min(1),
  preserved: z.array(z.string()),
  restartRequired: z.boolean(),
});

export const META_NODE_JOB_CONTRACTS = {
  ping: defineNodeJob("ping", PingArgsSchema, PingResultSchema),
  runtime_caps: defineNodeJob("runtime_caps", RuntimeCapsArgsSchema, RuntimeCapsResultSchema),
  node_self_update: defineNodeJob(
    "node_self_update",
    NodeSelfUpdateArgsSchema,
    NodeSelfUpdateResultSchema,
  ),
} as const satisfies NodeJobContractMap;

export type PingResult = z.infer<typeof PingResultSchema>;
export type RuntimeCapsResult = z.infer<typeof RuntimeCapsResultSchema>;
export type NodeSelfUpdateArgs = z.infer<typeof NodeSelfUpdateArgsSchema>;
export type NodeSelfUpdateResult = z.infer<typeof NodeSelfUpdateResultSchema>;
