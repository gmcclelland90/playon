import { nanoid } from "nanoid";

export type NodeJobKind = "ping" | "fs_list";

export interface NodeJob {
  id: string;
  nodeId: string;
  kind: NodeJobKind;
  args: Record<string, unknown>;
  status: "queued" | "running" | "done" | "failed";
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * In-process job queue for node-agent remote execution.
 * Sufficient for single-control-plane LAN hosts; jobs are not durable across API restarts.
 */
export class NodeJobService {
  private readonly jobs = new Map<string, NodeJob>();

  enqueue(nodeId: string, kind: NodeJobKind, args: Record<string, unknown> = {}): NodeJob {
    const now = new Date().toISOString();
    const job: NodeJob = {
      id: nanoid(),
      nodeId,
      kind,
      args,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    return { ...job };
  }

  get(jobId: string): NodeJob | null {
    const job = this.jobs.get(jobId);
    return job ? { ...job } : null;
  }

  /** Claim the oldest queued job for this node (or null). */
  claimNext(nodeId: string): NodeJob | null {
    const queued = [...this.jobs.values()]
      .filter((j) => j.nodeId === nodeId && j.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const job = queued[0];
    if (!job) return null;
    job.status = "running";
    job.updatedAt = new Date().toISOString();
    return { ...job };
  }

  complete(jobId: string, result: unknown): NodeJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`unknown_job: ${jobId}`);
    job.status = "done";
    job.result = result;
    job.error = undefined;
    job.updatedAt = new Date().toISOString();
    return { ...job };
  }

  fail(jobId: string, error: string): NodeJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`unknown_job: ${jobId}`);
    job.status = "failed";
    job.error = error;
    job.updatedAt = new Date().toISOString();
    return { ...job };
  }

  /** Poll until done/failed or timeout. */
  async waitFor(
    jobId: string,
    opts: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<NodeJob> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const intervalMs = opts.intervalMs ?? 200;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = this.get(jobId);
      if (!job) throw new Error(`unknown_job: ${jobId}`);
      if (job.status === "done" || job.status === "failed") return job;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`node_job_timeout: ${jobId}`);
  }
}

/** Singleton used by createApp + tools (one queue per process). */
export const nodeJobService = new NodeJobService();
