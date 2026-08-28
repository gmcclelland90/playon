import { describe, expect, it } from "vitest";
import {
  cpuPercentFromDockerSamples,
  memUsedFromDockerStats,
  resetContainerStatSamples,
  sampleContainerUsage,
  usageFromDockerStats,
} from "./container-stats.js";

const linuxPrev = {
  cpu_stats: {
    cpu_usage: { total_usage: 1_000 },
    system_cpu_usage: 10_000,
    online_cpus: 2,
  },
  memory_stats: { usage: 50_000_000 },
};

const linuxNext = {
  cpu_stats: {
    cpu_usage: { total_usage: 1_500 },
    system_cpu_usage: 12_000,
    online_cpus: 2,
  },
  memory_stats: { usage: 64_000_000 },
};

describe("container-stats", () => {
  it("maps Linux cgroup CPU and memory", () => {
    // cpu delta 500 / system 2000 * 2 * 100 = 50
    expect(usageFromDockerStats(linuxPrev, linuxNext)).toEqual({
      cpuPercent: 50,
      memUsedBytes: 64_000_000,
    });
  });

  it("prefers Windows privateworkingset", () => {
    expect(
      memUsedFromDockerStats({
        memory_stats: { usage: 1, privateworkingset: 80_000_000 },
      }),
    ).toBe(80_000_000);
  });

  it("returns undefined CPU when system counters did not advance", () => {
    expect(
      cpuPercentFromDockerSamples(
        { totalUsage: 10, systemUsage: 0, onlineCpus: 1 },
        { totalUsage: 20, systemUsage: 0, onlineCpus: 1 },
      ),
    ).toBeUndefined();
  });

  it("attaches usage from one-shot stats using the prior tick", async () => {
    resetContainerStatSamples();
    const first = await sampleContainerUsage([{ name: "playon-abc", id: "c1" }], {
      stats: async () => linuxPrev,
    });
    expect(first.get("playon-abc")?.memUsedBytes).toBe(50_000_000);
    expect(first.get("playon-abc")?.cpuPercent).toBeUndefined();

    const second = await sampleContainerUsage([{ name: "playon-abc", id: "c1" }], {
      stats: async () => linuxNext,
    });
    expect(second.get("playon-abc")).toEqual({ cpuPercent: 50, memUsedBytes: 64_000_000 });
  });

  it("omits a container when stats throw", async () => {
    resetContainerStatSamples();
    const out = await sampleContainerUsage([{ name: "gone" }], {
      stats: async () => {
        throw new Error("404");
      },
    });
    expect(out.size).toBe(0);
  });
});
