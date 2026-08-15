import { describe, expect, it } from "vitest";
import {
  displayServerStatus,
  evaluateJoinPathProbe,
  evaluateJoinReady,
  isLoopbackJoinHost,
  isUdpJoinUnprovenReason,
  JOIN_HOST_NOT_REACHABLE,
  JOIN_PATH_CANARY_SKILL,
  joinHostNotReachableResult,
  playerPanelStatusFromJoinReady,
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

  it("uses checkLoopback for the diagnostic leg and check for the advertised host", async () => {
    const seen: string[] = [];
    const result = await probeJoinPath({
      joinHost: "172.16.0.94",
      port: 25565,
      check: async (host) => {
        seen.push(`home:${host}`);
        return "closed";
      },
      checkLoopback: async (host) => {
        seen.push(`node:${host}`);
        return "closed";
      },
      loopbackScope: "node",
    });
    expect(seen).toEqual(["node:127.0.0.1", "home:172.16.0.94"]);
    expect(result.reason).toBe("join_host_closed");
    expect(result.loopbackScope).toBe("node");
    expect(result.ok).toBe(false);
  });

  it("does not treat Home-open loopback as node-open when checkLoopback is closed", async () => {
    const result = await probeJoinPath({
      joinHost: "172.16.0.94",
      port: 25565,
      check: async (host) => (host === "127.0.0.1" ? "open" : "closed"),
      checkLoopback: async () => "closed",
    });
    expect(result.loopbackState).toBe("closed");
    expect(result.joinHostState).toBe("closed");
    expect(result.reason).toBe("join_host_closed");
    expect(result.ok).toBe(false);
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

describe("evaluateJoinReady", () => {
  const advertisedClosed = evaluateJoinPathProbe({
    joinHost: "172.16.0.94",
    port: 25565,
    loopbackState: "open",
    joinHostState: "closed",
  });
  const advertisedOpen = evaluateJoinPathProbe({
    joinHost: "172.16.0.94",
    port: 25565,
    loopbackState: "open",
    joinHostState: "open",
  });

  it("localhost-open + advertised-closed is not ready", () => {
    const result = evaluateJoinReady({
      processStatus: "running",
      joinPath: advertisedClosed,
      protocol: "tcp",
    });
    expect(result.ready).toBe(false);
    expect(result.status).toBe("degraded");
    expect(result.reason).toBe("loopback_open_join_host_closed");
  });

  it("advertised-open is ready", () => {
    const result = evaluateJoinReady({
      processStatus: "running",
      joinPath: advertisedOpen,
      protocol: "tcp",
    });
    expect(result.ready).toBe(true);
    expect(result.status).toBe("running");
    expect(result.reason).toBe("join_host_open");
  });

  it("does not treat process-up as ready when the advertised host is closed", () => {
    const result = evaluateJoinReady({
      processStatus: "running",
      joinPath: advertisedClosed,
      queryOnline: false,
      protocol: "tcp",
    });
    expect(result.ready).toBe(false);
    expect(result.status).not.toBe("running");
  });

  it("treats query success on the advertised host as ready", () => {
    const result = evaluateJoinReady({
      processStatus: "running",
      joinPath: advertisedClosed,
      queryOnline: true,
      protocol: "tcp",
    });
    expect(result.ready).toBe(true);
    expect(result.reason).toBe("query_online");
  });

  it("keeps starting (not running) while the process is still binding", () => {
    const result = evaluateJoinReady({
      processStatus: "starting",
      joinPath: advertisedClosed,
      protocol: "tcp",
    });
    expect(result.ready).toBe(false);
    expect(result.status).toBe("starting");
  });

  it("does not claim UDP ready from process-up without advertised query proof", () => {
    const result = evaluateJoinReady({
      processStatus: "running",
      joinPath: advertisedOpen,
      protocol: "udp",
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("udp_join_unproven");
    expect(result.status).toBe("degraded");
  });

  it("keeps UDP canary reason codes when advertised host ports are bound", () => {
    const result = evaluateJoinReady({
      processStatus: "running",
      joinPath: advertisedOpen,
      protocol: "udp",
      hostPortsBound: true,
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("udp_join_unproven");
    expect(result.status).toBe("running");
    expect(result.hostPortsBound).toBe(true);
  });

  it("stays degraded for UDP when advertised host ports are unbound", () => {
    const result = evaluateJoinReady({
      processStatus: "running",
      joinPath: advertisedOpen,
      protocol: "udp",
      hostPortsBound: false,
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("udp_join_unproven");
    expect(result.status).toBe("degraded");
  });
});

describe("playerPanelStatusFromJoinReady", () => {
  const udpUnproven = evaluateJoinReady({
    processStatus: "running",
    joinPath: {
      ok: false,
      reason: "udp_not_tcp_probed",
      joinHost: "172.16.0.109",
      port: 16261,
      loopbackState: "closed",
      joinHostState: "closed",
    },
    protocol: "udp",
  });

  it("does not map udp_join_unproven / udp_not_tcp_probed to Not joinable when ports are bound", () => {
    expect(isUdpJoinUnprovenReason("udp_join_unproven")).toBe(true);
    expect(isUdpJoinUnprovenReason("udp_not_tcp_probed")).toBe(true);
    expect(udpUnproven.reason).toBe("udp_join_unproven");
    expect(udpUnproven.joinPath.reason).toBe("udp_not_tcp_probed");
    expect(udpUnproven.status).toBe("degraded");
    expect(
      playerPanelStatusFromJoinReady({ ...udpUnproven, hostPortsBound: true }, "running"),
    ).toBe("running");
    expect(
      playerPanelStatusFromJoinReady(
        { ...udpUnproven, reason: "udp_not_tcp_probed", hostPortsBound: true },
        "running",
      ),
    ).toBe("running");
  });

  it("stays Live when process is up and advertised UDP ports are bound", () => {
    const bound = evaluateJoinReady({
      processStatus: "running",
      joinPath: udpUnproven.joinPath,
      protocol: "udp",
      hostPortsBound: true,
    });
    expect(playerPanelStatusFromJoinReady(bound, "running")).toBe("running");
    expect(playerPanelStatusFromJoinReady(bound)).not.toBe("degraded");
  });

  it("uses query online as player Live even without a TCP join-path", () => {
    const online = evaluateJoinReady({
      processStatus: "running",
      joinPath: udpUnproven.joinPath,
      queryOnline: true,
      protocol: "udp",
    });
    expect(online.ready).toBe(true);
    expect(playerPanelStatusFromJoinReady(online, "running")).toBe("running");
  });

  it("keeps TCP join-path failures as degraded for players", () => {
    const closed = evaluateJoinReady({
      processStatus: "running",
      joinPath: evaluateJoinPathProbe({
        joinHost: "172.16.0.94",
        port: 25565,
        loopbackState: "open",
        joinHostState: "closed",
      }),
      protocol: "tcp",
    });
    expect(playerPanelStatusFromJoinReady(closed, "running")).toBe("degraded");
  });
});

describe("displayServerStatus", () => {
  it("never shows running unless ready is true", () => {
    expect(displayServerStatus("running", true)).toBe("running");
    expect(displayServerStatus("running", false)).toBe("degraded");
    expect(displayServerStatus("running", undefined)).toBe("degraded");
    expect(displayServerStatus("stopped", false)).toBe("stopped");
  });
});

describe("joinHostNotReachableResult", () => {
  it("returns a fail-fast RCON error instead of a connect timeout", () => {
    const report = evaluateJoinReady({
      processStatus: "running",
      joinPath: evaluateJoinPathProbe({
        joinHost: "172.16.0.94",
        port: 25565,
        loopbackState: "open",
        joinHostState: "closed",
      }),
      protocol: "tcp",
    });
    const blocked = joinHostNotReachableResult(report);
    expect(blocked.error).toBe(JOIN_HOST_NOT_REACHABLE);
    expect(blocked.joinHost).toBe("172.16.0.94");
    expect(blocked.hint).toMatch(/advertised join address/);
    expect(blocked.hint).not.toMatch(/rcon_connect_timeout/);
  });
});
