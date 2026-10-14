import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import {
  NodeJobError,
  NodeJobKindSchema,
  WINDOWS_OTA_ESM_BOOTSTRAP_PROCESS_NAME,
  WINDOWS_OTA_ESM_BOOTSTRAP_REL,
  isEsmBootstrapSelfUpdateArgs,
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

/** Vintage Windows OTA helpers must persist with the tracked self-update (#885). */
export function isDurableOtaBootstrapJob(job: Pick<NodeJob, "kind" | "args">): boolean {
  if (job.kind === "fs_write_text" && job.args.path === WINDOWS_OTA_ESM_BOOTSTRAP_REL) return true;
  if (job.kind === "process_start" && job.args.name === WINDOWS_OTA_ESM_BOOTSTRAP_PROCESS_NAME) {
    return true;
  }
  return false;
}

/** Running self-update is not abandoned on jobs/next — the Windows helper swaps after the agent exits. */
export function shouldAbandonRunningJobOnReclaim(kind: NodeJobKind): boolean {
  return kind !== "node_self_update";
}

/** Heartbeat with an older stamp than this means the Windows swap did not land. */
export const SELF_UPDATE_STALE_MS = 15 * 60 * 1000;

/** Progress line while Home waits for the new agent stamp (#1040). */
export const SELF_UPDATE_APPLY_STARTED_PROGRESS =
  "apply started; waiting for new version check-in";

export const SELF_UPDATE_STALE_OFFLINE_ERROR =
  "abandoned: new version did not check in";

export const SELF_UPDATE_STALE_OLD_ERROR = "abandoned: update did not land after restart";

export function isSelfUpdateStaleError(error: string | undefined): boolean {
  return Boolean(error && /did not land after restart|did not check in/.test(error));
}

/** True when a heartbeat/agent stamp is at least the job's target (swap landed). */
export function selfUpdateTargetReached(target: string, agentVersion: string): boolean {
  return Boolean(target && !isNewerVersion(target, agentVersion || "0.0.0"));
}

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
      (j) =>
        (j.status === "queued" || j.status === "running") &&
        (DURABLE_JOB_KINDS.has(j.kind) || isDurableOtaBootstrapJob(j)),
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

  enqueue(
    nodeId: string,
    kind: NodeJobKind,
    args: Record<string, unknown> = {},
    opts?: { status?: "queued" | "running" },
  ): NodeJob {
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
    const status = opts?.status ?? "queued";
    const job: NodeJob = {
      id: nanoid(),
      nodeId,
      kind,
      args: validated,
      status,
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
      (j) =>
        j.nodeId === nodeId &&
        j.kind === "node_self_update" &&
        j.status === "running" &&
        !isEsmBootstrapSelfUpdateArgs(j.args),
    );
    if (selfUpdateInFlight) {
      this.writePersist();
      return null;
    }
    const queued = [...this.jobs.values()]
      .filter(
        (j) =>
          j.nodeId === nodeId &&
          j.status === "queued" &&
          !isEsmBootstrapSelfUpdateArgs(j.args),
      )
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
   *
   * A dying Windows agent often POSTs `ok: true` *before* apply (#1040). That
   * report is parked as progress — only this heartbeat path may mark `done`.
   */
  reconcileSelfUpdateOnHeartbeat(
    nodeId: string,
    agentVersion: string,
    nowMs: number = Date.now(),
    staleMs: number = SELF_UPDATE_STALE_MS,
  ): NodeJob | null {
    const targetOf = (job: NodeJob): string =>
      typeof job.args.version === "string" ? job.args.version : "";
    const completeFromHeartbeat = (job: NodeJob): NodeJob =>
      this.complete(job.id, {
        version: agentVersion,
        installRoot: "heartbeat",
        preserved: [],
        restartRequired: false,
      });

    const active = this.findActive(nodeId, "node_self_update");
    if (active && selfUpdateTargetReached(targetOf(active), agentVersion)) {
      return completeFromHeartbeat(active);
    }
    if (!active) {
      // Recover a stale-fail if the new stamp finally checked in after the timer.
      const latest = this.findLatest(nodeId, "node_self_update");
      if (
        latest &&
        latest.status === "failed" &&
        isSelfUpdateStaleError(latest.error) &&
        selfUpdateTargetReached(targetOf(latest), agentVersion)
      ) {
        return completeFromHeartbeat(latest);
      }
      return null;
    }
    if (active.status !== "running") return null;
    if (this.isSelfUpdatePastStale(active, nowMs, staleMs) && isNewerVersion(targetOf(active), agentVersion || "0.0.0")) {
      return this.fail(active.id, SELF_UPDATE_STALE_OLD_ERROR);
    }
    return null;
  }

  /**
   * Fail a running/queued self-update that has been silent past `staleMs` with
   * no new-version check-in. Used when the node stays offline (no heartbeat).
   * Never marks `done`.
   */
  failStaleSelfUpdateIfNeeded(
    nodeId: string,
    nowMs: number = Date.now(),
    staleMs: number = SELF_UPDATE_STALE_MS,
  ): NodeJob | null {
    const job = this.findActive(nodeId, "node_self_update");
    if (!job) return null;
    if (!this.isSelfUpdatePastStale(job, nowMs, staleMs)) return null;
    return this.fail(job.id, SELF_UPDATE_STALE_OFFLINE_ERROR);
  }

  private isSelfUpdatePastStale(job: NodeJob, nowMs: number, staleMs: number): boolean {
    const stamped = Date.parse(job.updatedAt || job.createdAt);
    return Number.isFinite(stamped) && nowMs - stamped >= staleMs;
  }

  /**
   * Agent POST /result for a claimed job. `node_self_update` success is never
   * `done` here — the process that reports is still on the old stamp (Windows
   * helper applies after exit). Failures still land immediately.
   */
  reportAgentResult(
    jobId: string,
    body: { ok: true; result?: unknown } | { ok: false; error: string },
  ): NodeJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new NodeJobError("unknown_job", { detail: jobId });
    if (body.ok === false) return this.fail(jobId, body.error);
    if (job.kind === "node_self_update") {
      return this.setProgress(jobId, SELF_UPDATE_APPLY_STARTED_PROGRESS);
    }
    return this.complete(jobId, body.result);
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
    (DURABLE_JOB_KINDS.has(j.kind) || isDurableOtaBootstrapJob(j)) &&
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
