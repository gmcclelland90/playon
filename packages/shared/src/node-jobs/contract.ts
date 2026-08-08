import type { z } from "zod";
import type { NodeJobKind } from "../api.js";

/** One job kind's wire contract: what the control plane sends and expects back. */
export interface NodeJobContract<
  K extends NodeJobKind = NodeJobKind,
  A extends z.ZodTypeAny = z.ZodTypeAny,
  R extends z.ZodTypeAny = z.ZodTypeAny,
> {
  kind: K;
  argsSchema: A;
  resultSchema: R;
}

/**
 * Partial by design: kinds land family by family, and unregistered kinds keep
 * using the legacy untyped bag until their slice migrates them.
 */
export type NodeJobContractMap = { [K in NodeJobKind]?: NodeJobContract<K> };

export function defineNodeJob<
  K extends NodeJobKind,
  A extends z.ZodTypeAny,
  R extends z.ZodTypeAny,
>(kind: K, argsSchema: A, resultSchema: R): NodeJobContract<K, A, R> {
  return { kind, argsSchema, resultSchema };
}
