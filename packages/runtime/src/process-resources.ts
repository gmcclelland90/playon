import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import type { ProcessInfo } from "./types.js";

const execFileAsync = promisify(execFile);

export type ProcessUsage = {
  name: string;
  pid?: number;
  status: ProcessInfo["status"];
  cpuPercent?: number;
  memUsedBytes?: number;
};

export type ProcStatSample = {
  cpuTicks: number;
  rssBytes?: number;
};

/** Parse `/proc/<pid>/stat` utime+stime (fields 14–15) and rss pages (field 24). */
export function parseProcStat(stat: string, pageSize = 4096): ProcStatSample | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const rest = stat.slice(close + 1).trim().split(/\s+/);
  // After comm: state(3) … utime(14) stime(15) → indexes 11 and 12 in `rest` (field n is rest[n-3]).
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  const rssPages = Number(rest[21]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return {
    cpuTicks: utime + stime,
    ...(Number.isFinite(rssPages) && rssPages >= 0
      ? { rssBytes: rssPages * pageSize }
      : {}),
  };
}

export function parseProcStatusRss(status: string): number | undefined {
  const line = status.split("\n").find((l) => l.startsWith("VmRSS:"));
  if (!line) return undefined;
  const kb = Number(line.replace(/[^\d]/g, ""));
  if (!Number.isFinite(kb) || kb < 0) return undefined;
  return kb * 1024;
}

export function cpuPercentFromProcTicks(
  prevTicks: number,
  nextTicks: number,
  elapsedMs: number,
  clkTck = 100,
  ncpu = 1,
): number | undefined {
  if (!(elapsedMs > 0) || nextTicks < prevTicks) return undefined;
  const deltaSec = (nextTicks - prevTicks) / clkTck;
  const wall = elapsedMs / 1000;
  const cpus = ncpu > 0 ? ncpu : 1;
  const pct = (deltaSec / wall / cpus) * 100;
  if (!Number.isFinite(pct)) return undefined;
  return Math.min(100, Math.max(0, Math.round(pct * 10) / 10));
}

const lastProc = new Map<number, { ticks: number; at: number }>();

export function resetProcessResourceSamples(): void {
  lastProc.clear();
}

function sampleLinuxPid(pid: number, now: number, ncpu: number): { cpuPercent?: number; memUsedBytes?: number } {
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return {};
  }
  const parsed = parseProcStat(stat);
  if (!parsed) return {};
  let memUsedBytes = parsed.rssBytes;
  try {
    const rss = parseProcStatusRss(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
    if (rss != null) memUsedBytes = rss;
  } catch {
    /* keep rss pages */
  }
  const prev = lastProc.get(pid);
  lastProc.set(pid, { ticks: parsed.cpuTicks, at: now });
  const cpuPercent =
    prev != null
      ? cpuPercentFromProcTicks(prev.ticks, parsed.cpuTicks, now - prev.at, 100, ncpu)
      : undefined;
  return {
    ...(cpuPercent != null ? { cpuPercent } : {}),
    ...(memUsedBytes != null ? { memUsedBytes } : {}),
  };
}

type WinRow = { pid: number; memUsedBytes?: number; cpuSeconds?: number };

/** Parse `Get-CimInstance Win32_Process` CSV: ProcessId,WorkingSetSize,KernelModeTime,UserModeTime. */
export function parseWindowsProcessCsv(csv: string): WinRow[] {
  const rows: WinRow[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const parts = line.split(",").map((p) => p.trim());
    if (parts.length < 4) continue;
    const pid = Number(parts[0]);
    const ws = Number(parts[1]);
    const kernel = Number(parts[2]);
    const user = Number(parts[3]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    // KernelModeTime/UserModeTime are 100-nanosecond ticks.
    const cpuSeconds =
      Number.isFinite(kernel) && Number.isFinite(user) ? (kernel + user) / 10_000_000 : undefined;
    rows.push({
      pid,
      ...(Number.isFinite(ws) && ws >= 0 ? { memUsedBytes: Math.round(ws) } : {}),
      ...(cpuSeconds != null ? { cpuSeconds } : {}),
    });
  }
  return rows;
}

async function sampleWindowsPids(
  pids: number[],
  now: number,
  ncpu: number,
): Promise<Map<number, { cpuPercent?: number; memUsedBytes?: number }>> {
  const out = new Map<number, { cpuPercent?: number; memUsedBytes?: number }>();
  if (!pids.length) return out;
  const filter = pids.map((p) => `ProcessId=${p}`).join(" OR ");
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,WorkingSetSize,KernelModeTime,UserModeTime | ConvertTo-Csv -NoTypeInformation`,
      ],
      { timeout: 1500, windowsHide: true, encoding: "utf8" },
    );
    for (const row of parseWindowsProcessCsv(stdout)) {
      const prev = lastProc.get(row.pid);
      if (row.cpuSeconds != null) {
        lastProc.set(row.pid, { ticks: row.cpuSeconds * 100, at: now });
      }
      let cpuPercent: number | undefined;
      if (prev && row.cpuSeconds != null) {
        cpuPercent = cpuPercentFromProcTicks(prev.ticks, row.cpuSeconds * 100, now - prev.at, 100, ncpu);
      }
      out.set(row.pid, {
        ...(cpuPercent != null ? { cpuPercent } : {}),
        ...(row.memUsedBytes != null ? { memUsedBytes: row.memUsedBytes } : {}),
      });
    }
  } catch {
    /* older agents / locked-down hosts — omit native usage */
  }
  return out;
}

/**
 * Sample CPU/RSS for supervised native processes. Linux reads `/proc`;
 * Windows uses one CIM query. First tick after a pid appears has memory only.
 */
export async function sampleProcessUsage(
  procs: ProcessInfo[],
  opts?: { now?: number; ncpu?: number; platform?: NodeJS.Platform },
): Promise<ProcessUsage[]> {
  const now = opts?.now ?? Date.now();
  const ncpu = opts?.ncpu ?? 1;
  const platform = opts?.platform ?? process.platform;
  const running = procs.filter((p) => p.status === "running" && p.pid);
  if (platform === "win32") {
    const byPid = await sampleWindowsPids(
      running.map((p) => p.pid!),
      now,
      ncpu,
    );
    return procs.map((p) => ({
      name: p.name,
      pid: p.pid,
      status: p.status,
      ...(p.pid != null ? byPid.get(p.pid) : {}),
    }));
  }
  return procs.map((p) => {
    const extra = p.pid && p.status === "running" ? sampleLinuxPid(p.pid, now, ncpu) : {};
    return { name: p.name, pid: p.pid, status: p.status, ...extra };
  });
}
