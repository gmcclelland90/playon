import {
  isLocalNodeId,
  parseNodeJobArgs,
  parseNodeJobResult,
  toNodeJobError,
  type NodeJobArgsInput,
  type NodeJobKind,
  type NodeJobResult,
} from "@playon/shared";
import { nodeJobService } from "./node-jobs.js";

/** Dispatch options: args and result are inferred from the job kind. */
export interface NodeJobDispatch<K extends NodeJobKind> {
  nodeId: string | null | undefined;
  kind: K;
  args?: NodeJobArgsInput<K>;
  timeoutMs?: number;
  localHandler: () => Promise<NodeJobResult<K>> | NodeJobResult<K>;
}

/**
 * Dispatch a runtime job to a node. Local (`local` / unset) stays in-process via
 * `localHandler`. Remote / Cloud nodes use the agent job queue.
 *
 * Every kind is validated on both shores: args before enqueue (in
 * `NodeJobService`) and results after the wait — including results produced by
 * `localHandler`, so local and remote paths cannot drift.
 */
export async function dispatchNodeJob<K extends NodeJobKind>(
  opts: NodeJobDispatch<K>,
): Promise<NodeJobResult<K>> {
  if (isLocalNodeId(opts.nodeId)) {
    // Local calls skip the queue, so validate args here instead of in `enqueue`.
    parseNodeJobArgs(opts.kind, opts.args ?? {});
    return parseNodeJobResult(opts.kind, await opts.localHandler());
  }

  const job = nodeJobService.enqueue(
    opts.nodeId!,
    opts.kind,
    (opts.args ?? {}) as Record<string, unknown>,
  );
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
