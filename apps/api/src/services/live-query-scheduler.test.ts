import { describe, expect, it, vi } from "vitest";
import type { JoinReadyReport } from "@playon/shared";
import { LiveQueryScheduler } from "./live-query-scheduler.js";
import type { JoinReadyService } from "./join-ready.js";
import type { PlayerPanel } from "./player-panel.js";
import type { ServerQueryService } from "./server-query.js";
import type { ServerService } from "./servers.js";

function udpUnprovenReport(hostPortsBound: boolean | null): JoinReadyReport {
  return {
    ready: false,
    status: hostPortsBound === true ? "running" : "degraded",
    reason: "udp_join_unproven",
    protocol: "udp",
    queryOnline: null,
    hostPortsBound,
    joinPath: {
      ok: false,
      reason: "udp_not_tcp_probed",
      joinHost: "172.16.0.109",
      port: 16261,
      loopbackState: "closed",
      joinHostState: "closed",
    },
  };
}

describe("LiveQueryScheduler player panel status", () => {
  it("publishes running (not degraded) for UDP-only + host-ports ok", async () => {
    const publishForStatus = vi.fn(async () => undefined);
    const servers = {
      list: async () => [
        {
          id: "srv-udp",
          name: "UDP",
          game: "UDP Only",
          nodeId: "local",
          runtimeMode: "native",
          status: "running",
          dataPath: "/tmp/udp",
          createdAt: new Date(),
        },
      ],
    } as unknown as ServerService;
    const playerPanel = { publishForStatus } as unknown as PlayerPanel;
    const queries = {
      queryServer: async () => ({ online: false }),
    } as unknown as ServerQueryService;
    const joinReady = {
      probe: async () => udpUnprovenReport(true),
    } as unknown as JoinReadyService;

    const scheduler = new LiveQueryScheduler(servers, playerPanel, queries, joinReady, 0);
    const updated = await scheduler.tick();
    expect(updated).toBe(1);
    expect(publishForStatus).toHaveBeenCalledTimes(1);
    expect(publishForStatus).toHaveBeenCalledWith(
      "srv-udp",
      "running",
      expect.objectContaining({ online: false }),
    );
  });

  it("does not publish Not-joinable degraded for udp_not_tcp_probed when ports are bound", async () => {
    const publishForStatus = vi.fn(async () => undefined);
    const servers = {
      list: async () => [
        {
          id: "srv-udp",
          status: "running",
        },
      ],
    } as unknown as ServerService;
    const report = udpUnprovenReport(true);
    report.status = "degraded";
    const scheduler = new LiveQueryScheduler(
      servers,
      { publishForStatus } as unknown as PlayerPanel,
      { queryServer: async () => ({ online: false }) } as unknown as ServerQueryService,
      { probe: async () => report } as unknown as JoinReadyService,
      0,
    );
    await scheduler.tick();
    expect(publishForStatus).toHaveBeenCalledWith(
      "srv-udp",
      "running",
      expect.objectContaining({ online: false }),
    );
  });
});
