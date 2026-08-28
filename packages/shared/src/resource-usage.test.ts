import { describe, expect, it } from "vitest";
import {
  DISK_LOW_BYTES,
  DISK_WARN_BYTES,
  USAGE_HISTORY_LIMIT,
  appendUsageHistory,
  cpuTone,
  diskPressure,
  diskTone,
  emptyUsageHistory,
  formatBytesShort,
  hostMeterRows,
  hostResourceAlerts,
  parseUsageHistory,
  ramTone,
  serverMeterRows,
  serverResourceAlerts,
  usageSparkGeometry,
  usageValueVisible,
} from "./resource-usage.js";

describe("usage history ring", () => {
  it("omits empty samples and never invents zeros", () => {
    const next = appendUsageHistory(emptyUsageHistory(), { t: 1 }, { abc: { t: 1 } });
    expect(next.host).toEqual([]);
    expect(next.servers).toEqual({});
  });

  it("keeps disk-only samples from older agents", () => {
    const next = appendUsageHistory(emptyUsageHistory(), {
      t: 10,
      freeDiskBytes: 8 * 1024 ** 3,
    });
    expect(next.host).toEqual([{ t: 10, freeDiskBytes: 8 * 1024 ** 3 }]);
  });

  it("caps host and per-server rings", () => {
    let hist = emptyUsageHistory();
    for (let i = 0; i < USAGE_HISTORY_LIMIT + 5; i++) {
      hist = appendUsageHistory(
        hist,
        { t: i, cpuPercent: i },
        { game: { t: i, cpuPercent: 1 } },
      );
    }
    expect(hist.host).toHaveLength(USAGE_HISTORY_LIMIT);
    expect(hist.host[0]?.t).toBe(5);
    expect(hist.servers.game).toHaveLength(USAGE_HISTORY_LIMIT);
  });

  it("parses stored JSON and survives garbage", () => {
    expect(parseUsageHistory(undefined).host).toEqual([]);
    expect(parseUsageHistory("not-json").host).toEqual([]);
    expect(
      parseUsageHistory(
        JSON.stringify({ host: [{ t: 1, cpuPercent: 4 }], servers: { a: [{ t: 2, memUsedBytes: 3 }] } }),
      ),
    ).toEqual({
      host: [{ t: 1, cpuPercent: 4 }],
      servers: { a: [{ t: 2, memUsedBytes: 3 }] },
    });
  });
});

describe("tones and fills", () => {
  it("treats playon-dev-quiet numbers as ok", () => {
    expect(cpuTone(5.9)).toBe("ok");
    expect(ramTone(5.2 * 1024 ** 3, 62.5 * 1024 ** 3)).toBe("ok");
    expect(diskTone(1030 * 1024 ** 3)).toBe("ok");
    expect(diskPressure(1030 * 1024 ** 3)).toBeLessThan(0.1);
  });

  it("marks disk_low at the placement floor", () => {
    expect(diskTone(DISK_LOW_BYTES - 1)).toBe("danger");
    expect(diskTone(DISK_WARN_BYTES - 1)).toBe("warn");
    expect(diskPressure(100 * 1024 * 1024)).toBe(1);
  });

  it("builds host meters only for present fields", () => {
    expect(hostMeterRows({ freeDiskBytes: 2 * 1024 ** 3 }).map((r) => r.key)).toEqual(["disk"]);
    const rows = hostMeterRows({
      cpuPercent: 82,
      memUsedBytes: 56 * 1024 ** 3,
      memTotalBytes: 62 * 1024 ** 3,
      freeDiskBytes: 400 * 1024 * 1024,
    });
    expect(rows.map((r) => r.tone)).toEqual(["warn", "danger", "danger"]);
    expect(rows.find((r) => r.key === "cpu")?.value).toBe("82%");
  });

  it("builds server meters without inventing disk or RAM fill", () => {
    const rows = serverMeterRows({ cpuPercent: 1.5, memUsedBytes: 1.5 * 1024 ** 3 });
    expect(rows.map((r) => r.value)).toEqual(["1.5%", "1.5 GiB"]);
    expect(serverMeterRows({})).toEqual([]);
  });
});

describe("operator alerts", () => {
  it("pings when disk crosses the placement floor", () => {
    const alerts = hostResourceAlerts({
      nodeId: "win-1",
      nodeName: "playon-win-1",
      current: { freeDiskBytes: 400 * 1024 * 1024 },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "disk_low", tone: "danger", scope: "host" });
    expect(alerts[0]?.message).toMatch(/400 MiB free/);
  });

  it("does not invent a CPU alert when the field is missing", () => {
    expect(
      hostResourceAlerts({
        nodeId: "old",
        nodeName: "old-agent",
        current: { freeDiskBytes: 200 * 1024 ** 3 },
      }),
    ).toEqual([]);
  });

  it("softens a single CPU spike until it holds", () => {
    const once = hostResourceAlerts({
      nodeId: "dev",
      nodeName: "playon-dev",
      current: { cpuPercent: 92 },
      history: [{ t: 1, cpuPercent: 10 }, { t: 2, cpuPercent: 92 }],
    });
    expect(once[0]?.tone).toBe("warn");
    const held = hostResourceAlerts({
      nodeId: "dev",
      nodeName: "playon-dev",
      current: { cpuPercent: 93 },
      history: [{ t: 1, cpuPercent: 91 }, { t: 2, cpuPercent: 93 }],
    });
    expect(held[0]?.tone).toBe("danger");
  });

  it("flags a hot running game", () => {
    const alerts = serverResourceAlerts({
      nodeId: "dev",
      nodeName: "playon-dev",
      serverId: "mc",
      serverName: "Small Minecraft",
      current: { cpuPercent: 94, memUsedBytes: 1.5 * 1024 ** 3 },
    });
    expect(alerts[0]?.message).toMatch(/Small Minecraft on playon-dev is hot/);
  });

  it("formats compact byte labels", () => {
    expect(formatBytesShort(5.2 * 1024 ** 3)).toBe("5.2 GiB");
    expect(formatBytesShort(1030 * 1024 ** 3)).toBe("1030 GiB");
  });
});

describe("usage spark geometry", () => {
  it("hugs the floor for a quiet series and fills high when loaded", () => {
    const lineYs = (line: string) =>
      [...line.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((m) => Number(m[2]));
    const quiet = usageSparkGeometry([0.06, 0.05, 0.07, 0.04], 0.06, 100, 28);
    const loaded = usageSparkGeometry([0.2, 0.55, 0.82, 0.94], 0.94, 100, 28);
    expect(Math.min(...lineYs(quiet.line))).toBeGreaterThan(20);
    expect(Math.min(...lineYs(loaded.line))).toBeLessThan(10);
    expect(quiet.area.endsWith("Z")).toBe(true);
    expect(loaded.area.startsWith(loaded.line)).toBe(true);
  });

  it("draws a plateau from current fill when the ring is empty", () => {
    const geo = usageSparkGeometry([], 0.9, 100, 20);
    expect(geo.line).toMatch(/^M0\.0 /);
    expect(geo.line).toContain("L100.0 ");
  });

  it("skips null samples instead of inventing zeros", () => {
    const geo = usageSparkGeometry([0.8, null, 0.8], 0.8, 100, 20);
    const points = geo.line.match(/[ML][\d.]+ [\d.]+/g) ?? [];
    expect(points).toHaveLength(2);
  });

  it("keeps numbers off the face until hover or hot", () => {
    expect(usageValueVisible("ok")).toBe(false);
    expect(usageValueVisible("ok", true)).toBe(true);
    expect(usageValueVisible("warn")).toBe(true);
    expect(usageValueVisible("danger")).toBe(true);
  });
});
