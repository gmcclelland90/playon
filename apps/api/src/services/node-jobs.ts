import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import {
  NodeJobError,
  NodeJobKindSchema,
  isNewerVersion,
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
  /** Latest human-readable progress line from the agent (long-running jobs). */
  progress?: string;
  createdAt: string;
  updatedAt: string;
}

/** Kinds that survive a Home process restart (JSON file, not sqlite). */
const DURABLE_JOB_KINDS = new Set<NodeJobKind>(["node_self_update"]);

/** Running self-update is not abandoned on jobs/next — the Windows helper swaps after the agent exits. */
export function shouldAbandonRunningJobOnReclaim(kind: NodeJobKind): boolean {
  return kind !== "node_self_update";
}

/** Heartbeat with an older stamp than this means the Windows swap did not land. */
export const SELF_UPDATE_STALE_MS = 15 * 60 * 1000;

export function nodeSelfUpdateJobsPath(dataRoot: string): string {
  return path.join(dataRoot, "node-self-update-jobs.json");
}

/**
 * In-process job queue for node-agent remote execution.
 * Most kinds are RAM-only. `node_self_update` is also written to a JSON file when
 * `attachPersistFile` is called so a Home restart does not silently drop a queued Update.
 */
export class NodeJobService {
  private readonly jobs = new Map<string, NodeJob>();
  /** Last `jobKinds` advertisement per node; absent means "agent predates the advertisement". */
  private readonly advertised = new Map<string, Set<NodeJobKind>>();
  /** Wake hooks for in-flight `waitFor` polls, so shutdown can release them. */
  private readonly waiters = new Set<(reason: string) => void>();
  private persistPath: string | null = null;

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

  /** Load durable jobs from `filePath` and persist later mutations there. */
  attachPersistFile(filePath: string): void {
    this.persistPath = filePath;
    this.loadPersist();
  }

  private durableJobs(): NodeJob[] {
    return [...this.jobs.values()].filter(
      (j) => DURABLE_JOB_KINDS.has(j.kind) && (j.status === "queued" || j.status === "running"),
    );
  }

  private writePersist(): void {
    if (!this.persistPath) return;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      fs.writeFileSync(this.persistPath, `${JSON.stringify(this.durableJobs(), null, 2)}\n`, "utf8");
    } catch {
      // Disk full / permissions must not break enqueue or claim.
    }
  }

  private loadPersist(): void {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.persistPath, "utf8")) as unknown;
      if (!Array.isArray(raw)) return;
      const now = new Date().toISOString();
      for (const row of raw) {
        if (!isPersistedDurableJob(row)) continue;
        if (this.jobs.has(row.id)) continue;
        const status =
          row.status === "running" && shouldAbandonRunningJobOnReclaim(row.kind)
            ? "queued"
            : row.status;
        this.jobs.set(row.id, {
          ...row,
          status,
          error: status === "queued" ? undefined : row.error,
          updatedAt: now,
        });
      }
    } catch {
      // Corrupt file: start empty; next write replaces it.
    }
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
    this.writePersist();
    return { ...job };
  }

  get(jobId: string): NodeJob | null {
    const job = this.jobs.get(jobId);
    return job ? { ...job } : null;
  }

  /** Newest queued/running job of a kind for a node (for UI reconnect / dedupe). */
  findActive(nodeId: string, kind: NodeJobKind): NodeJob | null {
    const active = [...this.jobs.values()]
      .filter(
        (j) =>
          j.nodeId === nodeId &&
          j.kind === kind &&
          (j.status === "queued" || j.status === "running"),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return active[0] ? { ...active[0] } : null;
  }

  /** Newest job of a kind for a node (any status — UI failed/done surfacing). */
  findLatest(nodeId: string, kind: NodeJobKind): NodeJob | null {
    const matches = [...this.jobs.values()]
      .filter((j) => j.nodeId === nodeId && j.kind === kind)
      .sort((a, b) => {
        const byUpdated = b.updatedAt.localeCompare(a.updatedAt);
        return byUpdated !== 0 ? byUpdated : b.createdAt.localeCompare(a.createdAt);
      });
    return matches[0] ? { ...matches[0] } : null;
  }

  /** Claim the oldest queued job for this node (or null). */
  claimNext(nodeId: string): NodeJob | null {
    // Agent runs one job at a time. A new claim means a prior "running" job was
    // abandoned (crash / restart) — except node_self_update, whose Windows helper
    // kills the agent before reportJobResult and then swaps the tree. Reclaiming
    // that as failed is how playon-win-1 stayed on 0.2.3 after a successful Linux path.
    const now = new Date().toISOString();
    for (const j of this.jobs.values()) {
      if (j.nodeId !== nodeId || j.status !== "running") continue;
      if (!shouldAbandonRunningJobOnReclaim(j.kind)) continue;
      j.status = "failed";
      j.error = "abandoned: agent reclaimed without completing";
      j.updatedAt = now;
    }
    const selfUpdateInFlight = [...this.jobs.values()].some(
      (j) => j.nodeId === nodeId && j.kind === "node_self_update" && j.status === "running",
    );
    if (selfUpdateInFlight) {
      this.writePersist();
      return null;
    }
    const queued = [...this.jobs.values()]
      .filter((j) => j.nodeId === nodeId && j.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const job = queued[0];
    if (!job) {
      this.writePersist();
      return null;
    }
    job.status = "running";
    job.updatedAt = now;
    this.writePersist();
    return { ...job };
  }

  /**
   * After a self-update restart, the new agent heartbeats before it can POST
   * job result. Mark the in-flight update done when the stamp matches; fail it
   * if the old stamp is still reporting after `staleMs`.
   */
  reconcileSelfUpdateOnHeartbeat(
    nodeId: string,
    agentVersion: string,
    nowMs: number = Date.now(),
    staleMs: number = SELF_UPDATE_STALE_MS,
  ): NodeJob | null {
    const job = this.findActive(nodeId, "node_self_update");
    if (!job) return null;
    const target = typeof job.args.version === "string" ? job.args.version : "";
    if (target && !isNewerVersion(target, agentVersion || "0.0.0")) {
      return this.complete(job.id, {
        version: agentVersion,
        installRoot: "heartbeat",
        preserved: [],
        restartRequired: false,
      });
    }
    if (job.status !== "running") return null;
    const created = Date.parse(job.createdAt);
    if (!Number.isFinite(created) || nowMs - created < staleMs) return null;
    if (target && isNewerVersion(target, agentVersion || "0.0.0")) {
      return this.fail(job.id, "abandoned: update did not land after restart");
    }
    return null;
  }

  complete(jobId: string, result: unknown): NodeJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new NodeJobError("unknown_job", { detail: jobId });
    job.status = "done";
    job.result = result;
    job.error = undefined;
    job.updatedAt = new Date().toISOString();
    this.writePersist();
    return { ...job };
  }

  fail(jobId: string, error: string): NodeJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new NodeJobError("unknown_job", { detail: jobId });
    job.status = "failed";
    job.error = error;
    job.updatedAt = new Date().toISOString();
    this.writePersist();
    return { ...job };
  }

  /** Update progress for a running (or queued) job without completing it. */
  setProgress(jobId: string, progress: string): NodeJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new NodeJobError("unknown_job", { detail: jobId });
    job.progress = progress.slice(0, 500);
    job.updatedAt = new Date().toISOString();
    this.writePersist();
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
    let abortedFor: string | null = null;
    let wake: (() => void) | null = null;
    const waiter = (reason: string): void => {
      abortedFor = reason;
      wake?.();
    };
    this.waiters.add(waiter);
    try {
      while (Date.now() < deadline && !abortedFor) {
        const job = this.get(jobId);
        if (!job) throw new NodeJobError("unknown_job", { detail: jobId });
        if (job.status === "done" || job.status === "failed") return job;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, intervalMs);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = null;
      }
    } finally {
      this.waiters.delete(waiter);
    }
    throw new NodeJobError("timeout", {
      kind: this.jobs.get(jobId)?.kind,
      detail: abortedFor ? `job ${jobId} ${abortedFor}` : `job ${jobId} after ${timeoutMs}ms`,
    });
  }

  /**
   * Release every in-flight `waitFor` caller — best-effort shutdown help, so a
   * poll with a long timeout does not hold the control plane open. Waiters see
   * a `timeout` error carrying `reason`; queued jobs themselves are untouched.
   */
  abortWaiters(reason = "aborted"): number {
    const pending = [...this.waiters];
    this.waiters.clear();
    for (const waiter of pending) waiter(reason);
    return pending.length;
  }
}

function isPersistedDurableJob(raw: unknown): raw is NodeJob {
  if (!raw || typeof raw !== "object") return false;
  const j = raw as NodeJob;
  return (
    typeof j.id === "string" &&
    j.id.length > 0 &&
    typeof j.nodeId === "string" &&
    j.nodeId.length > 0 &&
    DURABLE_JOB_KINDS.has(j.kind) &&
    (j.status === "queued" || j.status === "running") &&
    typeof j.args === "object" &&
    j.args !== null &&
    typeof j.createdAt === "string" &&
    typeof j.updatedAt === "string"
  );
}

/** Singleton used by createApp + tools (one queue per process). */
export const nodeJobService = new NodeJobService();

export function attachNodeJobPersist(dataRoot: string): void {
  nodeJobService.attachPersistFile(nodeSelfUpdateJobsPath(dataRoot));
}
