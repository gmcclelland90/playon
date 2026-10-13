import { describe, expect, it } from "vitest";
import {
  decideDesiredStateRestore,
  isListedNeverAutoStart,
  isProtectedFromAutoStart,
  parseDesiredState,
  parseNeverAutoStartList,
} from "./desired-state.js";

describe("parseDesiredState", () => {
  it("only treats the literal running token as running", () => {
    expect(parseDesiredState("running")).toBe("running");
    expect(parseDesiredState("stopped")).toBe("stopped");
    expect(parseDesiredState("error")).toBe("stopped");
    expect(parseDesiredState(undefined)).toBe("stopped");
  });
});

describe("parseNeverAutoStartList", () => {
  it("splits ids and names on commas or whitespace", () => {
    expect(parseNeverAutoStartList("Hub, NZL\nFrontier")).toEqual(["Hub", "NZL", "Frontier"]);
    expect(parseNeverAutoStartList("  ")).toEqual([]);
    expect(parseNeverAutoStartList(undefined)).toEqual([]);
  });
});

describe("isProtectedFromAutoStart", () => {
  it("honours per-server opt-out and a never-auto-start marker", () => {
    expect(isProtectedFromAutoStart({ id: "lab-1", name: "Paper", autoStart: false })).toBe(true);
    expect(
      isProtectedFromAutoStart({ id: "lab-1", name: "Paper", neverAutoStartMarker: true }),
    ).toBe(true);
    expect(isProtectedFromAutoStart({ id: "lab-1", name: "Paper" })).toBe(false);
  });

  it("keeps sacred live names out of blind auto-start (#1016 / #1038)", () => {
    expect(isProtectedFromAutoStart({ id: "RxWubiUeCNNzXqnZ4E_9p", name: "Hub" })).toBe(true);
    expect(isProtectedFromAutoStart({ id: "nzl", name: "NewZombieLand3" })).toBe(true);
    expect(isProtectedFromAutoStart({ id: "x", name: "Disposable", game: "Frontier" })).toBe(true);
  });

  it("matches an explicit never-auto-start allow-skip list by id or name", () => {
    expect(
      isListedNeverAutoStart({ id: "abc", name: "Teeworlds" }, ["ABC", "other"]),
    ).toBe(true);
    expect(isListedNeverAutoStart({ id: "abc", name: "Teeworlds" }, ["teeworlds"])).toBe(true);
    expect(isListedNeverAutoStart({ id: "abc", name: "Teeworlds" }, ["nope"])).toBe(false);
  });
});

describe("decideDesiredStateRestore", () => {
  it("re-adopts a surviving PID even when the server is protected", () => {
    expect(
      decideDesiredStateRestore({
        desiredState: "running",
        processAlive: true,
        protectedFromAutoStart: true,
      }),
    ).toEqual({ action: "adopt", reason: "process_alive" });
  });

  it("starts a desired-running server that is not alive", () => {
    expect(
      decideDesiredStateRestore({
        desiredState: "running",
        processAlive: false,
      }),
    ).toEqual({ action: "start", reason: "desired_running" });
  });

  it("does not start stopped, opted-out, or protected servers", () => {
    expect(
      decideDesiredStateRestore({ desiredState: "stopped", processAlive: false }),
    ).toEqual({ action: "skip", reason: "desired_stopped" });
    expect(
      decideDesiredStateRestore({
        desiredState: "running",
        processAlive: false,
        autoStart: false,
      }),
    ).toEqual({ action: "skip", reason: "auto_start_opt_out" });
    expect(
      decideDesiredStateRestore({
        desiredState: "running",
        processAlive: false,
        protectedFromAutoStart: true,
      }),
    ).toEqual({ action: "skip", reason: "protected_from_auto_start" });
  });
});
