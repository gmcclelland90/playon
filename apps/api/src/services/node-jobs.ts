import { nanoid } from "nanoid";
import {
  NodeJobError,
  NodeJobKindSchema,
  parseNodeJobArgs,
  type NodeJobKind,
} from "@playon/shared";

export type { NodeJobKind };

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
  /** Last `jobKinds` advertisement per node; absent means "agent predates the advertisement". */
  private readonly advertised = new Map<string, Set<NodeJobKind>>();

  /**
   * Record what a node says it can execute (from heartbeat). Called with
   * `undefined` by pre-protocol agents, which keeps dispatch optimistic.
   */
  advertiseJobKinds(nodeId: string, kinds: NodeJobKind[] | undefined): void {
    if (!kinds) return;
    this.advertised.set(nodeId, new Set(kinds));
  }

  /** Drop the advertisement so the next heartbeat re-establishes ground truth. */
  forgetJobKinds(nodeId: string): void {
    this.advertised.delete(nodeId);
  }

  advertisedJobKinds(nodeId: string): NodeJobKind[] | null {
    const kinds = this.advertised.get(nodeId);
    return kinds ? [...kinds] : null;
  }

  /** Unknown advertisement = allowed; the agent still answers with a typed error. */
  supportsKind(nodeId: string, kind: NodeJobKind): boolean {
    const kinds = this.advertised.get(nodeId);
    return !kinds || kinds.has(kind);
  }

  enqueue(nodeId: string, kind: NodeJobKind, args: Record<string, unknown> = {}): NodeJob {
    NodeJobKindSchema.parse(kind);
    if (!this.supportsKind(nodeId, kind)) {
      throw new NodeJobError("unsupported_job_kind", {
        kind,
        detail: `node ${nodeId} does not advertise this kind`,
      });
    }
    // Args are validated (and defaulted) on this shore before anything is queued.
    const validated = parseNodeJobArgs(kind, args) as Record<string, unknown>;
    if (kind === "node_self_update") {
      // The agent restarts with a different kind set; re-learn it from the next heartbeat.
      this.forgetJobKinds(nodeId);
    }
    const now = new Date().toISOString();
    const job: NodeJob = {
      id: nanoid(),
      nodeId,
      kind,
      args: validated,
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
    if (!job) throw new NodeJobError("unknown_job", { detail: jobId });
    job.status = "done";
    job.result = result;
    job.error = undefined;
    job.updatedAt = new Date().toISOString();
    return { ...job };
  }

  fail(jobId: string, error: string): NodeJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new NodeJobError("unknown_job", { detail: jobId });
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
      if (!job) throw new NodeJobError("unknown_job", { detail: jobId });
      if (job.status === "done" || job.status === "failed") return job;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new NodeJobError("timeout", {
      kind: this.jobs.get(jobId)?.kind,
      detail: `job ${jobId} after ${timeoutMs}ms`,
    });
  }
}

/** Singleton used by createApp + tools (one queue per process). */
export const nodeJobService = new NodeJobService();
