import {
  isLocalNodeId,
  parseNodeJobArgs,
  parseNodeJobResult,
  toNodeJobError,
  type NodeJobArgsInput,
  type NodeJobKind,
  type NodeJobResult,
  type RegisteredNodeJobKind,
} from "@playon/shared";
import { nodeJobService } from "./node-jobs.js";

/** Typed dispatch options: args and result are inferred from the job kind. */
export interface TypedNodeJobDispatch<K extends RegisteredNodeJobKind> {
  nodeId: string | null | undefined;
  kind: K;
  args?: NodeJobArgsInput<K>;
  timeoutMs?: number;
  localHandler: () => Promise<NodeJobResult<K>> | NodeJobResult<K>;
}

/**
 * Compatibility shim for kinds that have no contract yet: args stay an untyped
 * bag and the caller asserts the result type. Removed at the end of W1.
 */
export interface LegacyNodeJobDispatch<T> {
  nodeId: string | null | undefined;
  kind: NodeJobKind;
  args?: Record<string, unknown>;
  timeoutMs?: number;
  localHandler: () => Promise<T> | T;
}

/**
 * Dispatch a runtime job to a node. Local (`local` / unset) stays in-process via
 * `localHandler`. Remote / Cloud nodes use the agent job queue.
 *
 * Registered kinds are validated on both shores: args before enqueue (in
 * `NodeJobService`) and results after the wait — including results produced by
 * `localHandler`, so local and remote paths cannot drift.
 */
export async function dispatchNodeJob<K extends RegisteredNodeJobKind>(
  opts: TypedNodeJobDispatch<K>,
): Promise<NodeJobResult<K>>;
export async function dispatchNodeJob<T = unknown>(opts: LegacyNodeJobDispatch<T>): Promise<T>;
export async function dispatchNodeJob(opts: LegacyNodeJobDispatch<unknown>): Promise<unknown> {
  if (isLocalNodeId(opts.nodeId)) {
    // Local calls skip the queue, so validate args here instead of in `enqueue`.
    parseNodeJobArgs(opts.kind, opts.args ?? {});
    return parseNodeJobResult(opts.kind, await opts.localHandler());
  }

  const job = nodeJobService.enqueue(opts.nodeId!, opts.kind, opts.args ?? {});
  const done = await nodeJobService.waitFor(job.id, {
    timeoutMs: opts.timeoutMs ?? 120_000,
  });
  if (done.status === "failed") {
    throw toNodeJobError(done.error, { kind: opts.kind });
  }
  return parseNodeJobResult(opts.kind, done.result);
}

export function nodeServerRelPath(serverId: string, ...parts: string[]): string {
  return ["servers", serverId, ...parts].join("/");
}
