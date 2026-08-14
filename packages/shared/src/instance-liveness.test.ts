import { describe, expect, it } from "vitest";
import {
  DEFAULT_PORT_DEAD_GRACE_MS,
  decideReconcileInstance,
  decideStartInstance,
} from "./instance-liveness.js";

describe("decideStartInstance", () => {
  it("reuses a healthy instance (alive + advertised ports bound)", () => {
    expect(decideStartInstance({ processAlive: true, hostPortsBound: true })).toBe("reuse");
  });

  it("reaps a leftover PID/container whose advertised ports are unbound", () => {
    expect(decideStartInstance({ processAlive: true, hostPortsBound: false })).toBe(
      "reap_then_start",
    );
  });

  it("reaps then starts when a process is alive but ports cannot be probed", () => {
    expect(decideStartInstance({ processAlive: true, hostPortsBound: null })).toBe(
      "reap_then_start",
    );
  });

  it("starts when nothing is alive", () => {
    expect(decideStartInstance({ processAlive: false, hostPortsBound: false })).toBe("start");
    expect(decideStartInstance({ processAlive: false, hostPortsBound: null })).toBe("start");
  });
});

describe("decideReconcileInstance", () => {
  it("maps a dead process onto stopped when Home thought it was up", () => {
    expect(
      decideReconcileInstance({
        processAlive: false,
        hostPortsBound: null,
        dbStatus: "running",
      }),
    ).toBe("stopped");
    expect(
      decideReconcileInstance({
        processAlive: false,
        hostPortsBound: false,
        dbStatus: "starting",
      }),
    ).toBe("stopped");
  });

  it("clears an error flag when the process is gone", () => {
    expect(
      decideReconcileInstance({
        processAlive: false,
        hostPortsBound: null,
        dbStatus: "error",
      }),
    ).toBe("stopped");
  });

  it("does not invent stopped when Home already recorded stopped", () => {
    expect(
      decideReconcileInstance({
        processAlive: false,
        hostPortsBound: false,
        dbStatus: "stopped",
      }),
    ).toBe("keep");
  });

  it("treats alive + bound ports as running", () => {
    expect(
      decideReconcileInstance({
        processAlive: true,
        hostPortsBound: true,
        dbStatus: "starting",
      }),
    ).toBe("running");
  });

  it("does not claim running when ports dropped after grace", () => {
    expect(
      decideReconcileInstance({
        processAlive: true,
        hostPortsBound: false,
        dbStatus: "running",
        startedAgoMs: DEFAULT_PORT_DEAD_GRACE_MS,
        graceMs: DEFAULT_PORT_DEAD_GRACE_MS,
      }),
    ).toBe("dead");
  });

  it("keeps starting while the process is still binding", () => {
    expect(
      decideReconcileInstance({
        processAlive: true,
        hostPortsBound: false,
        dbStatus: "starting",
        startedAgoMs: DEFAULT_PORT_DEAD_GRACE_MS,
      }),
    ).toBe("keep");
  });

  it("does not reap a just-started running process before grace", () => {
    expect(
      decideReconcileInstance({
        processAlive: true,
        hostPortsBound: false,
        dbStatus: "running",
        startedAgoMs: 1_000,
        graceMs: DEFAULT_PORT_DEAD_GRACE_MS,
      }),
    ).toBe("keep");
  });

  it("treats first-see already-running + unbound ports as dead immediately", () => {
    expect(
      decideReconcileInstance({
        processAlive: true,
        hostPortsBound: false,
        dbStatus: "running",
      }),
    ).toBe("dead");
    expect(
      decideReconcileInstance({
        processAlive: true,
        hostPortsBound: false,
        dbStatus: "running",
        startedAgoMs: null,
        graceMs: DEFAULT_PORT_DEAD_GRACE_MS,
      }),
    ).toBe("dead");
  });

  it("follows the process when the port probe is unavailable", () => {
    expect(
      decideReconcileInstance({
        processAlive: true,
        hostPortsBound: null,
        dbStatus: "running",
        startedAgoMs: DEFAULT_PORT_DEAD_GRACE_MS,
      }),
    ).toBe("running");
  });
});
