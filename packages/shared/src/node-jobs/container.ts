import { z } from "zod";
import { defineNodeJob, type NodeJobContractMap } from "./contract.js";

/**
 * Container job kinds — the Docker half of the node seam. Every kind addresses a
 * container by `id`, which may be either the container hash or the name the
 * control plane minted (`containerName(serverId)`); the agent passes it straight
 * to the adapter, which accepts both.
 *
 * Args are strict (a typo must fail loudly); results are lenient about extra
 * fields so a newer agent can add them without breaking an older control plane.
 */

/** Container hash or name. Both are opaque to the control plane. */
export const ContainerIdSchema = z.string().min(1).max(256);

/**
 * `serverId` only tells the agent which server's console to follow; a job with
 * no `serverId` still starts or stops the container, it just streams no logs.
 */
const ContainerServerIdSchema = z.string().min(1).optional();

export const ContainerStatusSchema = z.enum(["created", "running", "exited", "unknown"]);

/** What `container_create` and `container_inspect` both report back. */
export const ContainerInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  status: ContainerStatusSchema,
});

/** Lifecycle kinds acknowledge rather than describe; the state comes from inspect. */
const ContainerOkResultSchema = z.object({
  ok: z.boolean(),
});

export const ContainerPortBindingSchema = z
  .object({
    host: z.number().int().min(1).max(65535),
    container: z.number().int().min(1).max(65535),
    protocol: z.enum(["tcp", "udp"]).optional(),
  })
  .strict();

/**
 * A bind's host side is either jail-relative (the normal case — the agent
 * resolves it under the node data root) or already absolute, which is how a host
 * mounts a path outside the jail on purpose. Only the relative form can be
 * checked here, so that is the form we check.
 */
export const ContainerBindHostPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"), { message: "must not contain a NUL byte" })
  .refine(
    (value) => {
      const normalized = value.replace(/\\/g, "/");
      const absolute = normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized);
      return absolute || !normalized.split("/").includes("..");
    },
    { message: "relative host path must not contain a .. segment" },
  );

export const ContainerBindSchema = z
  .object({
    hostPath: ContainerBindHostPathSchema,
    /** Absolute path inside the container (e.g. the skill's `dockerDataMount`). */
    containerPath: z.string().min(1).max(4096),
  })
  .strict();

export const ContainerCreateArgsSchema = z
  .object({
    name: z.string().min(1).max(256),
    image: z.string().min(1).max(512),
    env: z.record(z.string(), z.string()).default({}),
    /** Docker Cmd — replaces image CMD; usually skill `dockerArgs`. */
    cmd: z.array(z.string()).default([]),
    ports: z.array(ContainerPortBindingSchema).default([]),
    binds: z.array(ContainerBindSchema).default([]),
    /** Optional; Windows-container engines default TTY on when omitted. */
    tty: z.boolean().optional(),
    isolation: z.enum(["process", "hyperv"]).optional(),
  })
  .strict();

export const ContainerCreateResultSchema = ContainerInfoSchema;

export const ContainerStartArgsSchema = z
  .object({
    id: ContainerIdSchema,
    serverId: ContainerServerIdSchema,
  })
  .strict();

export const ContainerStartResultSchema = ContainerOkResultSchema;

export const ContainerStopArgsSchema = z
  .object({
    id: ContainerIdSchema,
    serverId: ContainerServerIdSchema,
  })
  .strict();

export const ContainerStopResultSchema = ContainerOkResultSchema;

export const ContainerRemoveArgsSchema = z
  .object({
    id: ContainerIdSchema,
  })
  .strict();

export const ContainerRemoveResultSchema = ContainerOkResultSchema;

export const ContainerInspectArgsSchema = z
  .object({
    id: ContainerIdSchema,
  })
  .strict();

export const ContainerInspectResultSchema = ContainerInfoSchema;

/** Matches the agent's fallback when `tail` is absent. */
export const CONTAINER_LOGS_DEFAULT_TAIL = 100;

export const ContainerLogsArgsSchema = z
  .object({
    id: ContainerIdSchema,
    tail: z.number().int().min(0).max(10_000).default(CONTAINER_LOGS_DEFAULT_TAIL),
  })
  .strict();

export const ContainerLogsResultSchema = z.object({
  lines: z.array(z.string()),
});

export const ContainerStdinArgsSchema = z
  .object({
    id: ContainerIdSchema,
    /** One console command; the agent appends the newline if it is missing. */
    line: z.string().min(1),
  })
  .strict();

export const ContainerStdinResultSchema = ContainerOkResultSchema;

export const CONTAINER_NODE_JOB_CONTRACTS = {
  container_create: defineNodeJob(
    "container_create",
    ContainerCreateArgsSchema,
    ContainerCreateResultSchema,
  ),
  container_start: defineNodeJob(
    "container_start",
    ContainerStartArgsSchema,
    ContainerStartResultSchema,
  ),
  container_stop: defineNodeJob(
    "container_stop",
    ContainerStopArgsSchema,
    ContainerStopResultSchema,
  ),
  container_remove: defineNodeJob(
    "container_remove",
    ContainerRemoveArgsSchema,
    ContainerRemoveResultSchema,
  ),
  container_inspect: defineNodeJob(
    "container_inspect",
    ContainerInspectArgsSchema,
    ContainerInspectResultSchema,
  ),
  container_logs: defineNodeJob(
    "container_logs",
    ContainerLogsArgsSchema,
    ContainerLogsResultSchema,
  ),
  container_stdin: defineNodeJob(
    "container_stdin",
    ContainerStdinArgsSchema,
    ContainerStdinResultSchema,
  ),
} as const satisfies NodeJobContractMap;

export type ContainerStatus = z.infer<typeof ContainerStatusSchema>;
export type ContainerInfoResult = z.infer<typeof ContainerInfoSchema>;
export type ContainerPortBinding = z.infer<typeof ContainerPortBindingSchema>;
export type ContainerBind = z.infer<typeof ContainerBindSchema>;
export type ContainerCreateArgs = z.infer<typeof ContainerCreateArgsSchema>;
export type ContainerLogsResult = z.infer<typeof ContainerLogsResultSchema>;
