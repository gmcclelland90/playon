import type { z } from "zod";
import { NodeJobKindSchema, type NodeJobKind } from "../api.js";
import type { NodeJobContract } from "./contract.js";
import { NodeJobError } from "./errors.js";
import { FS_NODE_JOB_CONTRACTS } from "./fs.js";
import { META_NODE_JOB_CONTRACTS } from "./meta.js";

/**
 * Contract map for every migrated job kind. Families are folded in one slice at
 * a time; anything absent here still travels as an untyped bag (see `parseNodeJobArgs`).
 */
export const NODE_JOB_CONTRACTS = {
  ...META_NODE_JOB_CONTRACTS,
  ...FS_NODE_JOB_CONTRACTS,
} as const;

export type NodeJobContracts = typeof NODE_JOB_CONTRACTS;

/** Kinds with a typed contract today. */
export type RegisteredNodeJobKind = keyof NodeJobContracts & NodeJobKind;

/** Kinds still on the legacy shim. */
export type UnregisteredNodeJobKind = Exclude<NodeJobKind, RegisteredNodeJobKind>;

/** What a caller may pass as `args` for a kind (pre-parse, defaults optional). */
export type NodeJobArgsInput<K extends NodeJobKind> = K extends RegisteredNodeJobKind
  ? z.input<NodeJobContracts[K]["argsSchema"]>
  : Record<string, unknown>;

/** Args as the executing agent sees them (post-parse). */
export type NodeJobArgs<K extends NodeJobKind> = K extends RegisteredNodeJobKind
  ? z.output<NodeJobContracts[K]["argsSchema"]>
  : Record<string, unknown>;

export type NodeJobResult<K extends NodeJobKind> = K extends RegisteredNodeJobKind
  ? z.output<NodeJobContracts[K]["resultSchema"]>
  : unknown;

export const ALL_NODE_JOB_KINDS: readonly NodeJobKind[] = NodeJobKindSchema.options;

export const REGISTERED_NODE_JOB_KINDS = Object.keys(
  NODE_JOB_CONTRACTS,
) as RegisteredNodeJobKind[];

export function isRegisteredNodeJobKind(kind: unknown): kind is RegisteredNodeJobKind {
  return typeof kind === "string" && kind in NODE_JOB_CONTRACTS;
}

export function nodeJobContract(kind: NodeJobKind): NodeJobContract | undefined {
  return isRegisteredNodeJobKind(kind)
    ? (NODE_JOB_CONTRACTS[kind] as unknown as NodeJobContract)
    : undefined;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.join(".");
      return at ? `${at}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

/**
 * Validate args for a registered kind. Unregistered kinds pass through untouched
 * (the W1 compatibility shim) so migration stays incremental.
 */
export function parseNodeJobArgs<K extends NodeJobKind>(
  kind: K,
  args: unknown = {},
): NodeJobArgs<K> {
  const contract = nodeJobContract(kind);
  const raw = args ?? {};
  if (!contract) return raw as NodeJobArgs<K>;
  const parsed = contract.argsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new NodeJobError("validation_failed", {
      kind,
      detail: `args — ${describeIssues(parsed.error)}`,
    });
  }
  return parsed.data as NodeJobArgs<K>;
}

/** Validate a result for a registered kind; unregistered kinds pass through. */
export function parseNodeJobResult<K extends NodeJobKind>(
  kind: K,
  result: unknown,
): NodeJobResult<K> {
  const contract = nodeJobContract(kind);
  if (!contract) return result as NodeJobResult<K>;
  const parsed = contract.resultSchema.safeParse(result);
  if (!parsed.success) {
    throw new NodeJobError("validation_failed", {
      kind,
      detail: `result — ${describeIssues(parsed.error)}`,
    });
  }
  return parsed.data as NodeJobResult<K>;
}
