import fs from "node:fs";
import os from "node:os";
import { freeDiskBytes } from "./host-capabilities.js";

/** Host CPU / RAM / disk sample. CPU is omitted until a prior tick exists. */
export type HostResources = {
  cpuPercent?: number;
  memUsedBytes: number;
  memTotalBytes: number;
  freeDiskBytes?: number;
};

export type CpuTimesSample = {
  idle: number;
  total: number;
};

/** Sum idle + total ticks across all logical CPUs (Linux and Windows). */
export function readCpuTimes(cpus: os.CpuInfo[] = os.cpus()): CpuTimesSample {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** 0–100 host busy percent from two `os.cpus()` snapshots. */
export function cpuPercentFromTimes(prev: CpuTimesSample, next: CpuTimesSample): number | undefined {
  const idle = next.idle - prev.idle;
  const total = next.total - prev.total;
  if (!(total > 0) || idle < 0) return undefined;
  const busy = 1 - idle / total;
  if (!Number.isFinite(busy)) return undefined;
  return Math.min(100, Math.max(0, Math.round(busy * 1000) / 10));
}

export function sampleMemory(
  totalBytes: number = os.totalmem(),
  freeBytes: number = os.freemem(),
): { memUsedBytes: number; memTotalBytes: number } {
  const memTotalBytes = Math.max(0, Number(totalBytes) || 0);
  const free = Math.max(0, Number(freeBytes) || 0);
  return {
    memTotalBytes,
    memUsedBytes: Math.max(0, memTotalBytes - free),
  };
}

const lastCpuByKey = new Map<string, CpuTimesSample>();

/**
 * Cheap host sample for a heartbeat. CPU needs two ticks — the first call
 * after process start (or a new `sampleKey`) omits `cpuPercent`.
 */
export function sampleHostResources(
  dataRoot: string,
  opts?: {
    sampleKey?: string;
    cpus?: os.CpuInfo[];
    totalmem?: number;
    freemem?: number;
    disk?: number | undefined;
  },
): HostResources {
  const mem = sampleMemory(opts?.totalmem ?? os.totalmem(), opts?.freemem ?? os.freemem());
  const disk = opts?.disk !== undefined ? opts.disk : freeDiskBytes(dataRoot);
  const key = opts?.sampleKey ?? "host";
  const next = readCpuTimes(opts?.cpus ?? os.cpus());
  const prev = lastCpuByKey.get(key);
  lastCpuByKey.set(key, next);
  const cpuPercent = prev ? cpuPercentFromTimes(prev, next) : undefined;
  return {
    ...mem,
    ...(cpuPercent != null ? { cpuPercent } : {}),
    ...(disk != null ? { freeDiskBytes: disk } : {}),
  };
}

export function resetHostResourceSamples(): void {
  lastCpuByKey.clear();
}

/** Best-effort total disk for the volume that holds `dataRoot` (Linux + Windows Node 18.15+). */
export function totalDiskBytes(dataRoot: string): number | undefined {
  try {
    const stat = fs.statfsSync?.(dataRoot);
    if (stat) return Number(stat.blocks) * Number(stat.bsize);
  } catch {
    /* unsupported */
  }
  return undefined;
}
