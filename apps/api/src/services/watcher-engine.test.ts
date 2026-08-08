import { describe, expect, it, vi } from "vitest";
import type { Watcher } from "@playon/shared";
import { WatcherEngine } from "./watcher-engine.js";
import type { ControlPlane } from "../control-plane.js";

function baseWatcher(over: Partial<Watcher> = {}): Watcher {
  const now = Date.now();
  return {
    id: "w1",
    serverId: "s1",
    name: "Test",
    enabled: true,
    trigger: { kind: "log_pattern", pattern: "boom" },
    action: {
      kind: "tools",
      steps: [{ tool: "servers_logs_tail", args: {} }],
      continueOnError: false,
    },
    cooldownMs: 60_000,
    debounceMs: 0,
    confirmMode: "auto",
    source: "user",
    lastFiredAt: null,
    nextDueAt: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe("WatcherEngine matching", () => {
  it("skips fire while cooldown active", async () => {
    const w = baseWatcher({ lastFiredAt: Date.now() });
    const createRun = vi.fn();
    const finishRun = vi.fn();
    const markFired = vi.fn();
    const publish = vi.fn();
    const get = vi.fn(async () => w);
    const list = vi.fn(async () => [w]);

    const plane = {
      watchers: { list, get, createRun, finishRun, markFired, listDueSchedule: vi.fn(), listEnabled: vi.fn() },
      eventHub: { subscribe: () => () => undefined, publish },
      health: { checkServer: vi.fn() },
      queries: { queryServer: vi.fn() },
    } as unknown as ControlPlane;

    const engine = new WatcherEngine(plane);
    await engine.enqueue(w, { kind: "log_pattern", line: "boom" });
    // cooldown should prevent queueing a run
    expect(createRun).not.toHaveBeenCalled();
    expect(markFired).not.toHaveBeenCalled();
  });

  it("fires log_pattern match via event", async () => {
    const w = baseWatcher({ lastFiredAt: null, cooldownMs: 0 });
    const createRun = vi.fn(async () => ({
      id: "r1",
      watcherId: w.id,
      serverId: w.serverId,
      status: "running",
      triggerPayload: {},
      startedAt: Date.now(),
    }));
    const finishRun = vi.fn(async () => null);
    const markFired = vi.fn(async () => undefined);
    const get = vi.fn(async () => w);
    const list = vi.fn(async () => [w]);
    let listener: ((e: unknown) => void) | null = null;

    const plane = {
      watchers: { list, get, createRun, finishRun, markFired, listDueSchedule: vi.fn(), listEnabled: vi.fn() },
      eventHub: {
        subscribe: (fn: (e: unknown) => void) => {
          listener = fn;
          return () => undefined;
        },
        publish: vi.fn(),
      },
      health: { checkServer: vi.fn() },
      queries: { queryServer: vi.fn() },
      db: { insert: () => ({ values: async () => undefined }) },
      config: {},
      servers: { get: async () => ({ id: "s1", name: "Lab", status: "running" }) },
    } as unknown as ControlPlane;

    // Stub action path by making createRun/finishRun the observable; runWatcherAction may fail LLM.
    // Force tools path with allowlisted tool that will error in registry — still creates a run.
    const engine = new WatcherEngine(plane);
    engine.start();
    expect(listener).toBeTruthy();
    await listener!({
      type: "server.log",
      serverId: "s1",
      line: "something boom here",
    });
    // allow async drain
    await new Promise((r) => setTimeout(r, 50));
    expect(createRun).toHaveBeenCalled();
    expect(markFired).toHaveBeenCalled();
    engine.stop();
  });
});
