import { isLocalNodeId, type NodeJobKind } from "@playon/shared";
import { nodeJobService } from "./node-jobs.js";

/**
 * Dispatch a runtime job to a node. Local (`local` / unset) stays in-process via `localHandler`.
 * Remote / Cloud nodes use the agent job queue.
 */
export async function dispatchNodeJob<T = unknown>(opts: {
  nodeId: string | null | undefined;
  kind: NodeJobKind;
  args?: Record<string, unknown>;
  timeoutMs?: number;
  localHandler: () => Promise<T> | T;
}): Promise<T> {
  if (isLocalNodeId(opts.nodeId)) {
    return opts.localHandler();
  }

  const job = nodeJobService.enqueue(opts.nodeId!, opts.kind, opts.args ?? {});
  const done = await nodeJobService.waitFor(job.id, {
    timeoutMs: opts.timeoutMs ?? 120_000,
  });
  if (done.status === "failed") {
    throw new Error(done.error ?? `node_job_failed: ${opts.kind}`);
  }
  return done.result as T;
}

export function nodeServerRelPath(serverId: string, ...parts: string[]): string {
  return ["servers", serverId, ...parts].join("/");
}
