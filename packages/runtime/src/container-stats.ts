import Docker from "dockerode";
import { resolveDockerClientOptions } from "./docker-engine.js";

const DEFAULT_STATS_TIMEOUT_MS = 2_000;

/** Subset of Docker stats JSON we read (Linux cgroup + Windows). */
export type DockerStatsLike = {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: {
    usage?: number;
    limit?: number;
    privateworkingset?: number;
  };
};

export type ContainerUsage = {
  cpuPercent?: number;
  memUsedBytes?: number;
};

export type CpuCounterSample = {
  totalUsage: number;
  systemUsage: number;
  onlineCpus: number;
};

export function readDockerCpuSample(stats: DockerStatsLike | null | undefined): CpuCounterSample | null {
  const totalUsage = Number(stats?.cpu_stats?.cpu_usage?.total_usage);
  const systemUsage = Number(stats?.cpu_stats?.system_cpu_usage);
  const onlineCpus = Number(stats?.cpu_stats?.online_cpus) || 1;
  if (!Number.isFinite(totalUsage) || totalUsage < 0) return null;
  return {
    totalUsage,
    systemUsage: Number.isFinite(systemUsage) && systemUsage > 0 ? systemUsage : 0,
    onlineCpus: onlineCpus > 0 ? onlineCpus : 1,
  };
}

/**
 * Docker's usual formula: (cpu_delta / system_delta) * online_cpus * 100.
 * When system counters are missing (some Windows one-shots), fall back to
 * a raw total_usage delta so we still get a number on the next tick.
 */
export function cpuPercentFromDockerSamples(
  prev: CpuCounterSample,
  next: CpuCounterSample,
): number | undefined {
  const cpuDelta = next.totalUsage - prev.totalUsage;
  if (!(cpuDelta >= 0)) return undefined;
  const sysDelta = next.systemUsage - prev.systemUsage;
  if (sysDelta > 0) {
    const pct = (cpuDelta / sysDelta) * next.onlineCpus * 100;
    if (!Number.isFinite(pct)) return undefined;
    return Math.min(10_000, Math.max(0, Math.round(pct * 10) / 10));
  }
  return undefined;
}

export function memUsedFromDockerStats(stats: DockerStatsLike | null | undefined): number | undefined {
  const win = Number(stats?.memory_stats?.privateworkingset);
  if (Number.isFinite(win) && win > 0) return Math.round(win);
  const usage = Number(stats?.memory_stats?.usage);
  if (Number.isFinite(usage) && usage >= 0) return Math.round(usage);
  return undefined;
}

export function usageFromDockerStats(
  prev: DockerStatsLike | null | undefined,
  curr: DockerStatsLike | null | undefined,
): ContainerUsage {
  const memUsedBytes = memUsedFromDockerStats(curr);
  const prevCpu = readDockerCpuSample(prev);
  const nextCpu = readDockerCpuSample(curr);
  const cpuPercent =
    prevCpu && nextCpu ? cpuPercentFromDockerSamples(prevCpu, nextCpu) : undefined;
  return {
    ...(cpuPercent != null ? { cpuPercent } : {}),
    ...(memUsedBytes != null ? { memUsedBytes } : {}),
  };
}

const lastStatsByName = new Map<string, DockerStatsLike>();

export function resetContainerStatSamples(): void {
  lastStatsByName.clear();
}

type StatsRow = { name: string; id?: string };

/**
 * One-shot docker stats for running containers. Uses the previous tick for CPU
 * so we do not wait the engine's 1s stream sample. Failures omit usage.
 */
export async function sampleContainerUsage(
  rows: StatsRow[],
  opts?: {
    stats?: (idOrName: string) => Promise<DockerStatsLike | null>;
    timeoutMs?: number;
    platform?: NodeJS.Platform;
  },
): Promise<Map<string, ContainerUsage>> {
  const out = new Map<string, ContainerUsage>();
  if (!rows.length) return out;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_STATS_TIMEOUT_MS;
  const statsFn =
    opts?.stats ??
    (async (idOrName: string) => {
      const platform = opts?.platform ?? process.platform;
      const options =
        platform === "win32" ? await resolveDockerClientOptions({ platform, timeoutMs }) : undefined;
      if (platform === "win32" && !options) return null;
      const docker = new Docker(options);
      const raw = await docker.getContainer(idOrName).stats({ stream: false, "one-shot": true });
      return raw as DockerStatsLike;
    });

  const work = Promise.all(
    rows.slice(0, 80).map(async (row) => {
      const key = row.id || row.name;
      if (!key) return;
      try {
        const curr = await statsFn(key);
        if (!curr) return;
        const prev = lastStatsByName.get(row.name);
        lastStatsByName.set(row.name, curr);
        out.set(row.name, usageFromDockerStats(prev, curr));
      } catch {
        /* engine gone / timeout — omit */
      }
    }),
  );

  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
    /* omit */
  }
  return out;
}
