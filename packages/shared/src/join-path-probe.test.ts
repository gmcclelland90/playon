import { describe, expect, it } from "vitest";
import {
  evaluateJoinPathProbe,
  isLoopbackJoinHost,
  JOIN_PATH_CANARY_SKILL,
  probeJoinPath,
} from "./join-path-probe.js";

describe("isLoopbackJoinHost", () => {
  it("recognizes loopback literals", () => {
    expect(isLoopbackJoinHost("127.0.0.1")).toBe(true);
    expect(isLoopbackJoinHost("localhost")).toBe(true);
    expect(isLoopbackJoinHost("::1")).toBe(true);
    expect(isLoopbackJoinHost("172.16.0.94")).toBe(false);
    expect(isLoopbackJoinHost("")).toBe(false);
  });
});

describe("evaluateJoinPathProbe", () => {
  it("fails when loopback is open but published join host is not", () => {
    const result = evaluateJoinPathProbe({
      joinHost: "172.16.0.94",
      port: 25565,
      loopbackState: "open",
      joinHostState: "closed",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("loopback_open_join_host_closed");
  });

  it("passes when the published join host is open", () => {
    const result = evaluateJoinPathProbe({
      joinHost: "172.16.0.94",
      port: 25565,
      loopbackState: "open",
      joinHostState: "open",
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("join_host_open");
  });

  it("fails when join host is closed even if loopback is also closed", () => {
    const result = evaluateJoinPathProbe({
      joinHost: "172.16.0.94",
      port: 25565,
      loopbackState: "closed",
      joinHostState: "closed",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("join_host_closed");
  });

  it("treats loopback join host as a single path (not a false-green split)", () => {
    const open = evaluateJoinPathProbe({
      joinHost: "127.0.0.1",
      port: 25565,
      loopbackState: "open",
      joinHostState: "open",
    });
    expect(open.ok).toBe(true);
    expect(open.reason).toBe("join_host_is_loopback");

    const closed = evaluateJoinPathProbe({
      joinHost: "127.0.0.1",
      port: 25565,
      loopbackState: "closed",
      joinHostState: "closed",
    });
    expect(closed.ok).toBe(false);
    expect(closed.reason).toBe("join_host_loopback_closed");
  });

  it("fails on empty join host", () => {
    const result = evaluateJoinPathProbe({
      joinHost: "  ",
      port: 25565,
      loopbackState: "open",
      joinHostState: "open",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("join_host_empty");
  });
});

describe("probeJoinPath", () => {
  it("probes loopback and join host separately", async () => {
    const seen: string[] = [];
    const result = await probeJoinPath({
      joinHost: "172.16.0.94",
      port: 7777,
      check: async (host) => {
        seen.push(host);
        return host === "127.0.0.1" ? "open" : "closed";
      },
    });
    expect(seen).toEqual(["127.0.0.1", "172.16.0.94"]);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("loopback_open_join_host_closed");
  });

  it("does not double-probe when join host is loopback", async () => {
    let calls = 0;
    const result = await probeJoinPath({
      joinHost: "127.0.0.1",
      port: 7777,
      check: async () => {
        calls += 1;
        return "open";
      },
    });
    expect(calls).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("join_host_is_loopback");
  });
});

describe("join-path canary fixture", () => {
  it("uses the lab Docker fixture, not a curated games.* skill", () => {
    expect(JOIN_PATH_CANARY_SKILL).toBe("fixtures.lab-docker-server");
  });
});
