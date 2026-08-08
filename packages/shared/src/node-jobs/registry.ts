import type { z } from "zod";
import { NodeJobKindSchema, type NodeJobKind } from "../api.js";
import { CONTAINER_NODE_JOB_CONTRACTS } from "./container.js";
import type { CompleteNodeJobContractMap, NodeJobContract } from "./contract.js";
import { NodeJobError } from "./errors.js";
import { FS_NODE_JOB_CONTRACTS } from "./fs.js";
import { MANAGE_NODE_JOB_CONTRACTS } from "./manage.js";
import { META_NODE_JOB_CONTRACTS } from "./meta.js";
import { PROCESS_NODE_JOB_CONTRACTS } from "./process.js";
import { STEAMCMD_NODE_JOB_CONTRACTS } from "./steamcmd.js";

/**
 * Every job kind's wire contract, composed from the family modules. The
 * `satisfies` is the completeness gate: a kind added to the protocol enum without
 * a contract does not compile, so nothing can travel untyped again.
 */
export const NODE_JOB_CONTRACTS = {
  ...META_NODE_JOB_CONTRACTS,
  ...FS_NODE_JOB_CONTRACTS,
  ...CONTAINER_NODE_JOB_CONTRACTS,
  ...PROCESS_NODE_JOB_CONTRACTS,
  ...STEAMCMD_NODE_JOB_CONTRACTS,
  ...MANAGE_NODE_JOB_CONTRACTS,
} as const satisfies CompleteNodeJobContractMap;

export type NodeJobContracts = typeof NODE_JOB_CONTRACTS;

/** What a caller may pass as `args` for a kind (pre-parse, defaults optional). */
export type NodeJobArgsInput<K extends NodeJobKind> = z.input<NodeJobContracts[K]["argsSchema"]>;

/** Args as the executing agent sees them (post-parse). */
export type NodeJobArgs<K extends NodeJobKind> = z.output<NodeJobContracts[K]["argsSchema"]>;

export type NodeJobResult<K extends NodeJobKind> = z.output<NodeJobContracts[K]["resultSchema"]>;

export const ALL_NODE_JOB_KINDS: readonly NodeJobKind[] = NodeJobKindSchema.options;

export function isNodeJobKind(kind: unknown): kind is NodeJobKind {
  return typeof kind === "string" && kind in NODE_JOB_CONTRACTS;
}

/**
 * Undefined only for a kind this build does not know — a control plane and an
 * agent on different versions, which both shores report as `unsupported_job_kind`.
 */
export function nodeJobContract(kind: NodeJobKind): NodeJobContract | undefined {
  return isNodeJobKind(kind) ? (NODE_JOB_CONTRACTS[kind] as unknown as NodeJobContract) : undefined;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.join(".");
      return at ? `${at}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

function contractOrThrow(kind: NodeJobKind): NodeJobContract {
  const contract = nodeJobContract(kind);
  if (!contract) {
    throw new NodeJobError("unsupported_job_kind", { kind: String(kind) });
  }
  return contract;
}

/** Validate args for a kind, applying the contract's defaults. */
export function parseNodeJobArgs<K extends NodeJobKind>(
  kind: K,
  args: unknown = {},
): NodeJobArgs<K> {
  const parsed = contractOrThrow(kind).argsSchema.safeParse(args ?? {});
  if (!parsed.success) {
    throw new NodeJobError("validation_failed", {
      kind,
      detail: `args — ${describeIssues(parsed.error)}`,
    });
  }
  return parsed.data as NodeJobArgs<K>;
}

/** Validate a result for a kind, wherever it was produced. */
export function parseNodeJobResult<K extends NodeJobKind>(
  kind: K,
  result: unknown,
): NodeJobResult<K> {
  const parsed = contractOrThrow(kind).resultSchema.safeParse(result);
  if (!parsed.success) {
    throw new NodeJobError("validation_failed", {
      kind,
      detail: `result — ${describeIssues(parsed.error)}`,
    });
  }
  return parsed.data as NodeJobResult<K>;
}
