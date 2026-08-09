import { describe, expect, it } from "vitest";
import type { PlayOnApp } from "./app.js";
import type { AppConfig } from "./config.js";
import {
  startControlPlane,
  stopControlPlane,
  type ControlPlaneHost,
  type LifecycleHttpServer,
  type NamedScheduler,
  type StopReport,
} from "./control-plane-lifecycle.js";

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataRoot: "/tmp/playon-lifecycle",
    dbPath: "/tmp/playon-lifecycle/playon.db",
    sessionSecret: "test-session-secret-at-least-32-chars!!",
    skillsRoots: [],
    llmMode: "openai_compatible",
    runtimeMode: "docker",
    advertiseHost: "127.0.0.1",
    ...overrides,
  };
}

/**
 * One recorder for the whole shell: every seam appends, so a test asserts
 * ordering across build/listen/schedulers/waiters instead of per-spy counts.
 */
function harness(
  opts: {
    /** Whether the fake server reports `close` before the grace period. */
    closes?: "immediately" | "on-force" | "never";
    waitersAborted?: number;
    config?: AppConfig;
  } = {},
) {
  const events: string[] = [];
  const logs: Array<{ record: Record<string, unknown>; level: string }> = [];
  const closes = opts.closes ?? "immediately";
  let closeCallback: (() => void) | null = null;

  const server: LifecycleHttpServer = {
    close(cb) {
      events.push("http:close");
      closeCallback = cb ? () => cb() : null;
      if (closes === "immediately") closeCallback?.();
      return server;
    },
    closeIdleConnections() {
      events.push("http:close-idle");
    },
    closeAllConnections() {
      events.push("http:close-all");
      if (closes === "on-force") closeCallback?.();
    },
  };

  const scheduler = (name: string): NamedScheduler => ({
    name,
    scheduler: {
      start: () => events.push(`${name}:start`),
      stop: () => events.push(`${name}:stop`),
    },
  });

  const app = { controlPlane: {} } as unknown as PlayOnApp;
  const signalHandlers = new Map<string, () => void>();
  const stopped: StopReport[] = [];

  const host: Partial<ControlPlaneHost> = {
    loadConfig: () => opts.config ?? testConfig(),
    buildApp: () => {
      events.push("app:build");
      return app;
    },
    listen: () => {
      events.push("http:listen");
      return server;
    },
    createSchedulers: () => [scheduler("snapshot"), scheduler("live-query"), scheduler("watcher")],
    jobWaiters: {
      abortWaiters: (reason) => {
        events.push(`waiters:abort:${reason}`);
        return opts.waitersAborted ?? 0;
      },
    },
    signals: {
      once: (signal, handler) => signalHandlers.set(signal, handler),
      off: (signal) => signalHandlers.delete(signal),
    },
    log: (record, level = "info") => logs.push({ record, level }),
    drainGraceMs: 20,
    onStopped: (report) => stopped.push(report),
  };

  return { events, logs, host, signalHandlers, stopped };
}

describe("startControlPlane", () => {
  it("builds the plane, listens, then starts schedulers in order", async () => {
    const { events, host } = harness();
    const running = await startControlPlane(host);
    expect(events).toEqual([
      "app:build",
      "http:listen",
      "snapshot:start",
      "live-query:start",
      "watcher:start",
    ]);
    expect(running.schedulersStarted).toEqual(["snapshot", "live-query", "watcher"]);
    expect(running.config.port).toBe(0);
  });

  it("logs the start banner and warns when a production build has no web dist", async () => {
    const { logs, host } = harness({
      config: testConfig({ isProduction: true, webDist: "/nope/dist" }),
    });
    await startControlPlane(host);
    expect(logs[0]?.record.msg).toBe("playon_start");
    expect(logs[0]?.record.webDistReady).toBe(false);
    expect(logs[1]).toMatchObject({ level: "warn", record: { msg: "playon_web_dist_missing" } });
  });
});

describe("stopControlPlane", () => {
  it("closes HTTP, stops schedulers in reverse, then aborts job waiters", async () => {
    const { events, host } = harness({ waitersAborted: 2 });
    const running = await startControlPlane(host);
    const report = await stopControlPlane(running, "SIGTERM");

    expect(events.slice(5)).toEqual([
      "http:close",
      "http:close-idle",
      "watcher:stop",
      "live-query:stop",
      "snapshot:stop",
      "waiters:abort:control_plane_SIGTERM",
    ]);
    expect(report).toMatchObject({
      reason: "SIGTERM",
      schedulersStopped: ["watcher", "live-query", "snapshot"],
      waitersAborted: 2,
      httpClosed: true,
      forcedConnections: false,
    });
  });

  it("drains lingering WebSockets after the grace period", async () => {
    const { events, host } = harness({ closes: "on-force" });
    const running = await startControlPlane(host);
    const report = await running.stop("SIGINT");
    expect(events).toContain("http:close-all");
    expect(report).toMatchObject({ httpClosed: true, forcedConnections: true });
  });

  it("still settles when connections never report closed", async () => {
    const { host, stopped } = harness({ closes: "never" });
    const running = await startControlPlane(host);
    const report = await running.stop();
    expect(report).toMatchObject({ reason: "manual", httpClosed: false, forcedConnections: true });
    expect(stopped).toEqual([report]);
  });

  it("is idempotent — a second stop reuses the first shutdown", async () => {
    const { events, host } = harness();
    const running = await startControlPlane(host);
    const [first, second] = await Promise.all([running.stop("SIGTERM"), running.stop("SIGINT")]);
    expect(second).toBe(first);
    expect(first.reason).toBe("SIGTERM");
    expect(events.filter((e) => e === "http:close")).toHaveLength(1);
  });

  it("keeps a scheduler that throws from stranding the rest of shutdown", async () => {
    const { events, host } = harness();
    const schedulers = host.createSchedulers!;
    host.createSchedulers = (app) => {
      const entries = schedulers(app);
      entries[2]!.scheduler.stop = () => {
        throw new Error("watcher wedged");
      };
      return entries;
    };
    const running = await startControlPlane(host);
    const report = await running.stop();
    expect(report.schedulersStopped).toEqual(["watcher", "live-query", "snapshot"]);
    expect(events).toContain("snapshot:stop");
    expect(report.httpClosed).toBe(true);
  });

  it("survives a job waiter pool that throws", async () => {
    const { host } = harness();
    host.jobWaiters = {
      abortWaiters: () => {
        throw new Error("pool gone");
      },
    };
    const running = await startControlPlane(host);
    const report = await running.stop();
    expect(report.waitersAborted).toBe(0);
    expect(report.httpClosed).toBe(true);
  });
});

describe("shutdown signals", () => {
  it("stops on SIGTERM and detaches both handlers", async () => {
    const { host, signalHandlers, stopped } = harness();
    await startControlPlane(host);
    expect([...signalHandlers.keys()]).toEqual(["SIGTERM", "SIGINT"]);

    signalHandlers.get("SIGTERM")!();
    await vitestFlush();
    expect(stopped[0]).toMatchObject({ reason: "SIGTERM", httpClosed: true });
    expect(signalHandlers.size).toBe(0);
  });

  it("leaves process signals alone when no target is given", async () => {
    const { host, events } = harness();
    host.signals = null;
    await startControlPlane(host);
    expect(events).toContain("http:listen");
  });
});

/** Let the signal-triggered stop chain settle (it is started, not awaited). */
async function vitestFlush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
}
