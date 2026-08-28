import { describe, expect, it } from "vitest";
import { emptyUsageHistory } from "@playon/shared";
import { alertsForNode } from "./usage-history.js";

describe("alertsForNode", () => {
  it("combines host disk_low with a hot game", () => {
    const alerts = alertsForNode({
      nodeId: "dev",
      nodeName: "playon-dev",
      current: { freeDiskBytes: 200 * 1024 * 1024, cpuPercent: 6 },
      history: emptyUsageHistory(),
      hostedServers: [{ id: "mc", name: "Small Minecraft", cpuPercent: 96 }],
    });
    expect(alerts.map((a) => a.kind)).toEqual(["disk_low", "cpu_high"]);
    expect(alerts[1]?.scope).toBe("server");
  });
});
