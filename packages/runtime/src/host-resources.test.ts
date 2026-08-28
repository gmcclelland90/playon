import { describe, expect, it } from "vitest";
import {
  cpuPercentFromTimes,
  resetHostResourceSamples,
  sampleHostResources,
  sampleMemory,
} from "./host-resources.js";

describe("host-resources", () => {
  it("computes busy percent from two cpu snapshots", () => {
    expect(
      cpuPercentFromTimes({ idle: 80, total: 100 }, { idle: 85, total: 200 }),
    ).toBe(95);
    expect(cpuPercentFromTimes({ idle: 10, total: 10 }, { idle: 10, total: 10 })).toBeUndefined();
  });

  it("treats freemem as unused RAM", () => {
    expect(sampleMemory(16 * 1024 ** 3, 4 * 1024 ** 3)).toEqual({
      memTotalBytes: 16 * 1024 ** 3,
      memUsedBytes: 12 * 1024 ** 3,
    });
  });

  it("omits cpu on the first sample and reports it on the second", () => {
    resetHostResourceSamples();
    const first = sampleHostResources("/tmp", {
      sampleKey: "t1",
      cpus: [
        {
          model: "test",
          speed: 1,
          times: { user: 10, nice: 0, sys: 5, idle: 85, irq: 0 },
        },
      ],
      totalmem: 1000,
      freemem: 400,
      disk: 50,
    });
    expect(first.cpuPercent).toBeUndefined();
    expect(first.memUsedBytes).toBe(600);
    expect(first.memTotalBytes).toBe(1000);
    expect(first.freeDiskBytes).toBe(50);

    const second = sampleHostResources("/tmp", {
      sampleKey: "t1",
      cpus: [
        {
          model: "test",
          speed: 1,
          times: { user: 20, nice: 0, sys: 10, idle: 90, irq: 0 },
        },
      ],
      totalmem: 1000,
      freemem: 400,
      disk: 50,
    });
    // idle +20, total +20 → 0% busy? user+10 sys+5 idle+5 = 20, idle 5/20 = 25% idle → 75% busy
    expect(second.cpuPercent).toBe(75);
  });
});
