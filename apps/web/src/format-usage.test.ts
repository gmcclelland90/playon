import { describe, expect, it } from "vitest";
import { formatHostUsage, formatServerUsage, nodeUsageChips } from "./format-usage";

describe("format-usage", () => {
  it("joins host CPU, RAM, and free disk", () => {
    expect(
      formatHostUsage({
        cpuPercent: 12,
        memUsedBytes: 4 * 1024 ** 3,
        memTotalBytes: 16 * 1024 ** 3,
        freeDiskBytes: 48 * 1024 ** 3,
      }),
    ).toBe("CPU 12% · RAM 4.0 GiB / 16.0 GiB · 48.0 GiB free");
  });

  it("shows only disk when older agents omit CPU/RAM", () => {
    expect(formatHostUsage({ freeDiskBytes: 2 * 1024 ** 3 })).toBe("2.0 GiB free");
    expect(formatHostUsage({})).toBeNull();
  });

  it("formats per-server CPU and memory", () => {
    expect(formatServerUsage({ cpuPercent: 8.2, memUsedBytes: 512 * 1024 ** 2 })).toBe(
      "8.2% · 512 MiB",
    );
    expect(formatServerUsage({})).toBeNull();
  });

  it("builds Settings chips and skips missing fields", () => {
    expect(nodeUsageChips({ freeDiskBytes: 1024 ** 3 })).toEqual([{ label: "1.0 GiB free" }]);
    expect(
      nodeUsageChips({
        cpuPercent: 4,
        memUsedBytes: 1024 ** 3,
        memTotalBytes: 8 * 1024 ** 3,
        freeDiskBytes: 10 * 1024 ** 3,
      }).map((c) => c.label),
    ).toEqual(["CPU 4%", "1.0 GiB / 8.0 GiB", "10.0 GiB free"]);
  });
});
