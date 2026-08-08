import type { Watcher, WsEvent } from "@playon/shared";
import { validateLogPattern } from "@playon/shared";
import type { ControlPlane } from "../control-plane.js";
import { runWatcherAction } from "./watcher-actions.js";
import { WatcherLogBuffer } from "./watcher-context.js";
import type { ServerHealthReport } from "./health.js";

const GLOBAL_AGENT_CAP = 3;

type QueueItem = {
  watcher: Watcher;
  triggerPayload: Record<string, unknown>;
  force?: boolean;
};

/**
 * Matches triggers, applies debounce/cooldown, and runs watcher actions
 * with per-server serialization and a global agent concurrency cap.
 */
export class WatcherEngine {
  readonly logBuffer = new WatcherLogBuffer();
  private unsubscribe: (() => void) | null = null;
  private readonly serverBusy = new Set<string>();
  private readonly serverQueues = new Map<string, QueueItem[]>();
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingDebounce = new Map<string, QueueItem>();
  private agentInFlight = 0;

  constructor(private readonly plane: ControlPlane) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.plane.eventHub.subscribe((event) => {
      void this.onEvent(event);
    });
    console.log("watcher engine: event subscriptions active");
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
    this.pendingDebounce.clear();
  }

  /** Manual or schedule fire. */
  async enqueue(
    watcher: Watcher,
    triggerPayload: Record<string, unknown>,
    opts?: { force?: boolean },
  ): Promise<void> {
    if (!watcher.enabled && !opts?.force) return;
    this.scheduleOrRun({ watcher, triggerPayload, force: opts?.force });
  }

  async tickSchedule(nowMs: number = Date.now()): Promise<number> {
    const due = await this.plane.watchers.listDueSchedule(nowMs);
    for (const w of due) {
      await this.enqueue(w, { kind: "schedule", at: nowMs });
    }
    return due.length;
  }

  async tickHealthAndQuery(): Promise<void> {
    const enabled = await this.plane.watchers.listEnabled();
    const byServer = new Map<string, Watcher[]>();
    for (const w of enabled) {
      if (w.trigger.kind !== "health" && w.trigger.kind !== "query") continue;
      const list = byServer.get(w.serverId) ?? [];
      list.push(w);
      byServer.set(w.serverId, list);
    }

    for (const [serverId, list] of byServer) {
      const healthWatchers = list.filter((w) => w.trigger.kind === "health");
      const queryWatchers = list.filter((w) => w.trigger.kind === "query");

      if (healthWatchers.length) {
        let report: ServerHealthReport | null = null;
        try {
          report = await this.plane.health.checkServer(serverId, { remediate: false });
        } catch {
          continue;
        }
        for (const w of healthWatchers) {
          if (w.trigger.kind !== "health") continue;
          if (this.healthMatches(w, report)) {
            await this.enqueue(w, {
              kind: "health",
              ok: report.ok,
              escalations: report.escalations,
              checks: report.checks,
            });
          }
        }
      }

      if (queryWatchers.length) {
        let live: { players?: number; map?: string } | null = null;
        try {
          live = (await this.plane.queries.queryServer(serverId)) as {
            players?: number;
            map?: string;
          };
        } catch {
          continue;
        }
        for (const w of queryWatchers) {
          if (w.trigger.kind !== "query") continue;
          if (this.queryMatches(w, live)) {
            await this.enqueue(w, { kind: "query", live });
          }
        }
      }
    }
  }

  private async onEvent(event: WsEvent): Promise<void> {
    if (event.type === "server.log") {
      this.logBuffer.push(event.serverId, event.line);
      const watchers = (await this.plane.watchers.list(event.serverId)).filter(
        (w) => w.enabled && w.trigger.kind === "log_pattern",
      );
      for (const w of watchers) {
        if (w.trigger.kind !== "log_pattern") continue;
        const check = validateLogPattern(w.trigger.pattern, w.trigger.flags);
        if (!check.ok) continue;
        if (check.regex.test(event.line)) {
          await this.enqueue(w, {
            kind: "log_pattern",
            line: event.line,
            nodeId: event.nodeId,
          });
        }
      }
      return;
    }

    if (event.type === "server.status") {
      const watchers = (await this.plane.watchers.list(event.serverId)).filter(
        (w) => w.enabled && w.trigger.kind === "server_status",
      );
      for (const w of watchers) {
        if (w.trigger.kind !== "server_status") continue;
        if (w.trigger.statuses.includes(event.status)) {
          await this.enqueue(w, { kind: "server_status", status: event.status });
        }
      }
      return;
    }

    if (event.type === "panel.input") {
      const watchers = (await this.plane.watchers.list(event.serverId)).filter(
        (w) => w.enabled && w.trigger.kind === "panel_input",
      );
      for (const w of watchers) {
        if (w.trigger.kind !== "panel_input") continue;
        if (w.trigger.inputType === event.inputType) {
          await this.enqueue(w, {
            kind: "panel_input",
            inputType: event.inputType,
            blockId: event.blockId,
            payload: event.payload,
          });
        }
      }
    }
  }

  private healthMatches(w: Watcher, report: ServerHealthReport): boolean {
    if (w.trigger.kind !== "health") return false;
    const failed = report.checks.filter((c) => !c.ok);
    if (!failed.length) return false;
    if (w.trigger.checkIds?.length) {
      const set = new Set(w.trigger.checkIds);
      if (!failed.some((c) => set.has(c.id))) return false;
    }
    if (w.trigger.onFail?.length) {
      const want = new Set(w.trigger.onFail);
      if (!failed.some((c) => want.has(c.onFail))) return false;
    }
    return true;
  }

  private queryMatches(
    w: Watcher,
    live: { players?: number; map?: string } | null,
  ): boolean {
    if (w.trigger.kind !== "query" || !live) return false;
    const { predicate, value } = w.trigger;
    const players = live.players ?? 0;
    switch (predicate) {
      case "players_eq":
        return players === Number(value);
      case "players_gte":
        return players >= Number(value);
      case "players_lte":
        return players <= Number(value);
      case "map_eq":
        return (live.map ?? "") === String(value);
      default:
        return false;
    }
  }

  private scheduleOrRun(item: QueueItem): void {
    const { watcher } = item;
    if (!item.force && watcher.cooldownMs > 0 && watcher.lastFiredAt) {
      if (Date.now() - watcher.lastFiredAt < watcher.cooldownMs) return;
    }

    if (watcher.debounceMs > 0 && !item.force) {
      this.pendingDebounce.set(watcher.id, item);
      const existing = this.debounceTimers.get(watcher.id);
      if (existing) clearTimeout(existing);
      const t = setTimeout(() => {
        this.debounceTimers.delete(watcher.id);
        const pending = this.pendingDebounce.get(watcher.id);
        this.pendingDebounce.delete(watcher.id);
        if (pending) this.pushQueue(pending);
      }, watcher.debounceMs);
      this.debounceTimers.set(watcher.id, t);
      return;
    }

    this.pushQueue(item);
  }

  private pushQueue(item: QueueItem): void {
    const q = this.serverQueues.get(item.watcher.serverId) ?? [];
    q.push(item);
    this.serverQueues.set(item.watcher.serverId, q);
    void this.drainServer(item.watcher.serverId);
  }

  private async drainServer(serverId: string): Promise<void> {
    if (this.serverBusy.has(serverId)) return;
    this.serverBusy.add(serverId);
    try {
      while (true) {
        const q = this.serverQueues.get(serverId);
        if (!q?.length) break;
        const item = q.shift()!;
        if (item.watcher.action.kind === "agent") {
          while (this.agentInFlight >= GLOBAL_AGENT_CAP) {
            await sleep(250);
          }
          this.agentInFlight++;
          try {
            await this.runOne(item);
          } finally {
            this.agentInFlight--;
          }
        } else {
          await this.runOne(item);
        }
      }
    } finally {
      this.serverBusy.delete(serverId);
      if ((this.serverQueues.get(serverId) ?? []).length) {
        void this.drainServer(serverId);
      }
    }
  }

  private async runOne(item: QueueItem): Promise<void> {
    const { watcher, triggerPayload } = item;
    // Re-check cooldown at execution time (unless forced).
    const fresh = (await this.plane.watchers.get(watcher.id)) ?? watcher;
    if (!item.force && fresh.cooldownMs > 0 && fresh.lastFiredAt) {
      if (Date.now() - fresh.lastFiredAt < fresh.cooldownMs) {
        const skipped = await this.plane.watchers.createRun({
          watcherId: watcher.id,
          serverId: watcher.serverId,
          status: "skipped",
          triggerPayload: { ...triggerPayload, reason: "cooldown" },
        });
        await this.plane.watchers.finishRun(skipped.id, { status: "skipped" });
        this.plane.eventHub.publish({
          type: "watcher.run",
          watcherId: watcher.id,
          serverId: watcher.serverId,
          runId: skipped.id,
          status: "skipped",
        });
        return;
      }
    }

    const run = await this.plane.watchers.createRun({
      watcherId: watcher.id,
      serverId: watcher.serverId,
      status: "running",
      triggerPayload,
    });
    this.plane.eventHub.publish({
      type: "watcher.fired",
      watcherId: watcher.id,
      serverId: watcher.serverId,
      runId: run.id,
      triggerKind: String(triggerPayload.kind ?? watcher.trigger.kind),
    });
    this.plane.eventHub.publish({
      type: "watcher.run",
      watcherId: watcher.id,
      serverId: watcher.serverId,
      runId: run.id,
      status: "running",
    });

    await this.plane.watchers.markFired(watcher.id);

    try {
      const outcome = await runWatcherAction(
        this.plane,
        fresh,
        this.logBuffer,
        triggerPayload,
      );
      await this.plane.watchers.finishRun(run.id, {
        status: outcome.ok ? "ok" : "error",
        result: outcome.result,
        error: outcome.error,
      });
      this.plane.eventHub.publish({
        type: "watcher.run",
        watcherId: watcher.id,
        serverId: watcher.serverId,
        runId: run.id,
        status: outcome.ok ? "ok" : "error",
        error: outcome.error,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "watcher_run_failed";
      await this.plane.watchers.finishRun(run.id, {
        status: "error",
        error: message,
      });
      this.plane.eventHub.publish({
        type: "watcher.run",
        watcherId: watcher.id,
        serverId: watcher.serverId,
        runId: run.id,
        status: "error",
        error: message,
      });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
