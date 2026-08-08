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

/** What one family module contributes: its own kinds, keyed by kind. */
export type NodeJobContractMap = { [K in NodeJobKind]?: NodeJobContract<K> };

/**
 * Every kind in the protocol, contracted. The registry is checked against this,
 * so adding a kind to `NodeJobKindSchema` without a contract fails to compile.
 */
export type CompleteNodeJobContractMap = { [K in NodeJobKind]: NodeJobContract<K> };

export function defineNodeJob<
  K extends NodeJobKind,
  A extends z.ZodTypeAny,
  R extends z.ZodTypeAny,
>(kind: K, argsSchema: A, resultSchema: R): NodeJobContract<K, A, R> {
  return { kind, argsSchema, resultSchema };
}
