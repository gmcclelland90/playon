import { serve } from "@hono/node-server";
import { createApp, type PlayOnApp } from "./app.js";
import { loadConfig, type AppConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { applyBootstrap } from "./db/migrate.js";
import { LiveQueryScheduler } from "./services/live-query-scheduler.js";
import { nodeJobService } from "./services/node-jobs.js";
import { SnapshotScheduler } from "./services/snapshot-scheduler.js";
import { WatcherScheduler } from "./services/watcher-scheduler.js";
import { webDistReady } from "./static-web.js";

/** The `node:http` slice this module needs, so tests can pass a fake listener. */
export interface LifecycleHttpServer {
  close(cb?: (err?: Error) => void): unknown;
  /** Node >= 18.2: drop keep-alive sockets that are between requests. */
  closeIdleConnections?(): void;
  /** Node >= 18.2: destroy what is left, including upgraded WebSockets. */
  closeAllConnections?(): void;
}

export interface LifecycleScheduler {
  start(): void;
  stop(): void;
}

/** A scheduler plus the name reported in start/stop ordering. */
export interface NamedScheduler {
  name: string;
  scheduler: LifecycleScheduler;
}

/** Releases callers parked in `NodeJobService.waitFor` so shutdown is not held by a poll. */
export interface JobWaiterPool {
  abortWaiters(reason: string): number;
}

export interface SignalTarget {
  once(signal: NodeJS.Signals, handler: () => void): unknown;
  off(signal: NodeJS.Signals, handler: () => void): unknown;
}

export type LifecycleLogLevel = "info" | "warn";

export interface StopReport {
  /** `"SIGTERM"`, `"SIGINT"`, or whatever the caller passed to stop. */
  reason: string;
  /** Scheduler names in the order they were stopped (reverse of start). */
  schedulersStopped: string[];
  waitersAborted: number;
  httpClosed: boolean;
  /** True when connections outlived the grace period and were destroyed. */
  forcedConnections: boolean;
  durationMs: number;
}

export interface RunningControlPlane {
  config: AppConfig;
  app: PlayOnApp;
  server: LifecycleHttpServer;
  /** Scheduler names in start order. */
  readonly schedulersStarted: readonly string[];
  stop(reason?: string): Promise<StopReport>;
}

/**
 * Every seam the process shell touches. Production defaults live in
 * `defaultControlPlaneHost`; unit tests override the parts they assert on.
 */
export interface ControlPlaneHost {
  loadConfig(): AppConfig;
  buildApp(config: AppConfig): PlayOnApp;
  listen(app: PlayOnApp, config: AppConfig): LifecycleHttpServer;
  createSchedulers(app: PlayOnApp): NamedScheduler[];
  /** Null skips the best-effort waiter abort. */
  jobWaiters: JobWaiterPool | null;
  /** Null skips SIGTERM/SIGINT registration (tests, embedded use). */
  signals: SignalTarget | null;
  log(record: Record<string, unknown>, level?: LifecycleLogLevel): void;
  /** How long stop waits for open connections before destroying them. */
  drainGraceMs: number;
  /** Called once stop settles, including when a signal triggered it. */
  onStopped(report: StopReport): void;
}

const DEFAULT_DRAIN_GRACE_MS = 5_000;
/** Extra window after connections are destroyed, so `close` can report back. */
const FORCED_CLOSE_WAIT_MS = 500;
const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

function consoleLog(record: Record<string, unknown>, level: LifecycleLogLevel = "info"): void {
  const line = JSON.stringify(record);
  if (level === "warn") console.warn(line);
  else console.log(line);
}

export function defaultControlPlaneHost(): ControlPlaneHost {
  return {
    loadConfig: () => loadConfig(),
    buildApp: (config) => {
      applyBootstrap(config.dbPath);
      const { db } = createDb(config.dbPath);
      return createApp(db, config);
    },
    listen: (app, config) => {
      const server = serve({
        fetch: app.fetch,
        port: config.port,
        hostname: config.host ?? "127.0.0.1",
      });
      app.injectWebSocket(server as Parameters<typeof app.injectWebSocket>[0]);
      return server as unknown as LifecycleHttpServer;
    },
    createSchedulers: (app) => {
      const { servers, playerPanel, queries, snapshots, watcherEngine } = app.controlPlane;
      return [
        { name: "snapshot", scheduler: new SnapshotScheduler(snapshots) },
        {
          name: "live-query",
          scheduler: new LiveQueryScheduler(servers, playerPanel, queries),
        },
        { name: "watcher", scheduler: new WatcherScheduler(watcherEngine) },
      ];
    },
    jobWaiters: nodeJobService,
    signals: process,
    log: consoleLog,
    drainGraceMs: Number(process.env.PLAYON_SHUTDOWN_GRACE_MS ?? DEFAULT_DRAIN_GRACE_MS),
    onStopped: () => {},
  };
}

/** Resolves true if `promise` settles within `ms`, false on timeout. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    void promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}

/**
 * Bring up the control plane: build the service graph, listen, then start the
 * schedulers. SIGTERM/SIGINT are wired to `stop` unless `signals` is null.
 */
export function startControlPlane(overrides: Partial<ControlPlaneHost> = {}): RunningControlPlane {
  const host: ControlPlaneHost = { ...defaultControlPlaneHost(), ...overrides };
  const config = host.loadConfig();
  const app = host.buildApp(config);
  const webReady = Boolean(config.webDist && webDistReady(config.webDist));

  host.log({
    msg: "playon_start",
    env: config.isProduction ? "production" : "development",
    bind: `http://${config.host ?? "127.0.0.1"}:${config.port}`,
    advertiseHost: config.advertiseHost,
    webDist: config.webDist,
    webDistReady: webReady,
    llmMode: config.llmMode,
    runtimeMode: config.runtimeMode,
    dataRoot: config.dataRoot,
  });

  if (config.isProduction && !webReady) {
    host.log(
      {
        msg: "playon_web_dist_missing",
        hint: "run pnpm build so apps/web/dist exists, or set PLAYON_WEB_DIST",
        webDist: config.webDist,
      },
      "warn",
    );
  }

  const server = host.listen(app, config);
  const schedulers = host.createSchedulers(app);
  for (const entry of schedulers) entry.scheduler.start();

  let stopping: Promise<StopReport> | null = null;
  let detachSignals = (): void => {};

  const stop = (reason = "manual"): Promise<StopReport> => {
    stopping ??= runStop(reason);
    return stopping;
  };

  async function runStop(reason: string): Promise<StopReport> {
    const startedAt = Date.now();
    detachSignals();
    host.log({ msg: "playon_stopping", reason });

    // Refuse new connections first; existing ones drain below.
    const httpClosed = new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    server.closeIdleConnections?.();

    const schedulersStopped: string[] = [];
    for (const entry of [...schedulers].reverse()) {
      try {
        entry.scheduler.stop();
      } catch {
        // a stuck scheduler must not strand the rest of shutdown
      }
      schedulersStopped.push(entry.name);
    }

    let waitersAborted = 0;
    try {
      waitersAborted = host.jobWaiters?.abortWaiters(`control_plane_${reason}`) ?? 0;
    } catch {
      // best-effort by contract
    }

    let closed = await settlesWithin(httpClosed, host.drainGraceMs);
    let forcedConnections = false;
    if (!closed) {
      // WebSockets (admin + panel) never go idle on their own.
      forcedConnections = true;
      server.closeAllConnections?.();
      closed = await settlesWithin(httpClosed, FORCED_CLOSE_WAIT_MS);
    }

    const report: StopReport = {
      reason,
      schedulersStopped,
      waitersAborted,
      httpClosed: closed,
      forcedConnections,
      durationMs: Date.now() - startedAt,
    };
    host.log({ msg: "playon_stopped", ...report });
    host.onStopped(report);
    return report;
  }

  if (host.signals) {
    const target = host.signals;
    const handlers = SHUTDOWN_SIGNALS.map((signal): [NodeJS.Signals, () => void] => {
      const handler = () => {
        void stop(signal);
      };
      target.once(signal, handler);
      return [signal, handler];
    });
    detachSignals = () => {
      for (const [signal, handler] of handlers) target.off(signal, handler);
      detachSignals = () => {};
    };
  }

  return {
    config,
    app,
    server,
    schedulersStarted: schedulers.map((entry) => entry.name),
    stop,
  };
}

/** Graceful shutdown for a plane returned by `startControlPlane` (idempotent). */
export function stopControlPlane(
  running: RunningControlPlane,
  reason = "manual",
): Promise<StopReport> {
  return running.stop(reason);
}
