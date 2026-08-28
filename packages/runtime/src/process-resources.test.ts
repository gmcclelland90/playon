import { describe, expect, it } from "vitest";
import {
  cpuPercentFromProcTicks,
  parseProcStat,
  parseProcStatusRss,
  parseWindowsProcessCsv,
} from "./process-resources.js";

describe("process-resources", () => {
  it("parses /proc/pid/stat utime+stime and rss pages", () => {
    const parsed = parseProcStat(
      "1 (cat) R 0 1 1 0 0 0 0 0 0 0 30 10 0 0 20 0 1 0 123 0 77 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0",
    );
    expect(parsed?.cpuTicks).toBe(40);
    expect(parsed?.rssBytes).toBe(77 * 4096);
  });

  it("reads VmRSS from /proc/pid/status", () => {
    expect(parseProcStatusRss("Name:\tjava\nVmRSS:\t  2048 kB\n")).toBe(2048 * 1024);
    expect(parseProcStatusRss("Name:\tjava\n")).toBeUndefined();
  });

  it("computes process CPU percent from tick deltas", () => {
    // 50 ticks in 1s at 100 Hz on 1 CPU = 50%
    expect(cpuPercentFromProcTicks(100, 150, 1000, 100, 1)).toBe(50);
    expect(cpuPercentFromProcTicks(10, 5, 1000)).toBeUndefined();
  });

  it("parses a Windows CIM CSV including the header", () => {
    const csv = [
      "ProcessId,WorkingSetSize,KernelModeTime,UserModeTime",
      "4242,1048576,10000000,20000000",
    ].join("\n");
    expect(parseWindowsProcessCsv(csv)).toEqual([
      { pid: 4242, memUsedBytes: 1_048_576, cpuSeconds: 3 },
    ]);
  });
});
