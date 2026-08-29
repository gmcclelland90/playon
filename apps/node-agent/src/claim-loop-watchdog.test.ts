import { describe, expect, it } from "vitest";
import {
  CLAIM_WATCHDOG_ENV,
  CLAIM_WATCHDOG_EXIT_CODE,
  DEFAULT_CLAIM_WATCHDOG_IDLE_MS,
  claimWatchdogIdleMs,
  createClaimLoopWatchdog,
} from "./claim-loop-watchdog.js";

describe("claimWatchdogIdleMs", () => {
  it("defaults to five minutes and accepts a positive override", () => {
    expect(claimWatchdogIdleMs({})).toBe(DEFAULT_CLAIM_WATCHDOG_IDLE_MS);
    expect(claimWatchdogIdleMs({ [CLAIM_WATCHDOG_ENV]: "120000" })).toBe(120_000);
    expect(claimWatchdogIdleMs({ [CLAIM_WATCHDOG_ENV]: "nope" })).toBe(DEFAULT_CLAIM_WATCHDOG_IDLE_MS);
  });
});

describe("createClaimLoopWatchdog", () => {
  it("does not exit while claim polls keep landing", () => {
    let t = 0;
    const exits: number[] = [];
    const wd = createClaimLoopWatchdog({
      idleMs: 1_000,
      now: () => t,
      exit: (code) => {
        exits.push(code);
      },
    });
    wd.markClaimPoll();
    t = 900;
    expect(wd.check()).toBe(false);
    wd.markClaimPoll();
    t = 1_800;
    expect(wd.check()).toBe(false);
    expect(exits).toEqual([]);
  });

  it("exits when heartbeat is still ticking but claim is dead (hung OTA leftover)", () => {
    let t = 0;
    const exits: number[] = [];
    const logs: string[] = [];
    const wd = createClaimLoopWatchdog({
      idleMs: 1_000,
      now: () => t,
      exit: (code) => {
        exits.push(code);
      },
      log: (m) => logs.push(m),
    });
    wd.markJobStarted("node_self_update");
    t = 1_001;
    expect(wd.check()).toBe(true);
    expect(exits).toEqual([CLAIM_WATCHDOG_EXIT_CODE]);
    expect(logs[0]).toMatch(/node_self_update/);
    expect(logs[0]).toMatch(/supervisor restarts/);
    expect(wd.check()).toBe(false);
  });

  it("treats job progress as healthy so long SteamCMD stays up", () => {
    let t = 0;
    const exits: number[] = [];
    const wd = createClaimLoopWatchdog({
      idleMs: 1_000,
      now: () => t,
      exit: (code) => {
        exits.push(code);
      },
    });
    wd.markJobStarted("steamcmd_app_update");
    t = 900;
    wd.markJobProgress();
    t = 1_800;
    expect(wd.check()).toBe(false);
    wd.markJobFinished();
    t = 2_000;
    expect(wd.check()).toBe(false);
    t = 3_100;
    expect(wd.check()).toBe(true);
    expect(exits).toEqual([CLAIM_WATCHDOG_EXIT_CODE]);
  });
});
