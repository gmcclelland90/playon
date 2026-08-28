/**
 * In-app host/server usage: short history, glanceable meter fills, and
 * operator-visible alerts. Missing fields stay omitted — never invent zeros
 * for older agents that only send disk.
 */

export const USAGE_HISTORY_LIMIT = 24;

/** Same floor as placement `disk_low` (win-1 / #911). */
export const DISK_LOW_BYTES = 512 * 1024 * 1024;
export const DISK_WARN_BYTES = 5 * 1024 ** 3;
/** Free at or above this is a quiet disk bar (no fake "used %" without a total). */
export const DISK_OK_BYTES = 20 * 1024 ** 3;

export const CPU_HIGH_PERCENT = 90;
export const CPU_WARN_PERCENT = 75;
export const RAM_HIGH_RATIO = 0.9;
export const RAM_WARN_RATIO = 0.75;

export type UsageTone = "ok" | "warn" | "danger";

export type HostUsageSample = {
  t: number;
  cpuPercent?: number;
  memUsedBytes?: number;
  memTotalBytes?: number;
  freeDiskBytes?: number;
};

export type ServerUsageSample = {
  t: number;
  cpuPercent?: number;
  memUsedBytes?: number;
};

export type UsageHistory = {
  host: HostUsageSample[];
  servers: Record<string, ServerUsageSample[]>;
};

export type ResourceAlertKind = "disk_low" | "cpu_high" | "ram_high";

export type ResourceAlert = {
  kind: ResourceAlertKind;
  tone: "warn" | "danger";
  scope: "host" | "server";
  nodeId: string;
  nodeName: string;
  serverId?: string;
  serverName?: string;
  message: string;
};

export type MeterKey = "cpu" | "ram" | "disk";

export type UsageMeterRow = {
  key: MeterKey;
  label: string;
  value: string;
  fill: number;
  tone: UsageTone;
  series: Array<number | null>;
};

function finiteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function emptyUsageHistory(): UsageHistory {
  return { host: [], servers: {} };
}

function isHostSample(v: unknown): v is HostUsageSample {
  if (!v || typeof v !== "object") return false;
  const o = v as HostUsageSample;
  return finiteNumber(o.t);
}

function isServerSample(v: unknown): v is ServerUsageSample {
  if (!v || typeof v !== "object") return false;
  const o = v as ServerUsageSample;
  return finiteNumber(o.t);
}

export function parseUsageHistory(raw: string | null | undefined): UsageHistory {
  if (!raw?.trim()) return emptyUsageHistory();
  try {
    const parsed = JSON.parse(raw) as Partial<UsageHistory>;
    const host = Array.isArray(parsed.host) ? parsed.host.filter(isHostSample) : [];
    const servers: Record<string, ServerUsageSample[]> = {};
    if (parsed.servers && typeof parsed.servers === "object") {
      for (const [id, rows] of Object.entries(parsed.servers)) {
        if (!id || !Array.isArray(rows)) continue;
        servers[id] = rows.filter(isServerSample);
      }
    }
    return { host, servers };
  } catch {
    return emptyUsageHistory();
  }
}

function pushRing<T>(items: T[], next: T, limit = USAGE_HISTORY_LIMIT): T[] {
  const out = items.length >= limit ? items.slice(items.length - limit + 1) : items.slice();
  out.push(next);
  return out;
}

export function compactHostSample(sample: HostUsageSample): HostUsageSample | null {
  const out: HostUsageSample = { t: sample.t };
  if (finiteNumber(sample.cpuPercent)) out.cpuPercent = sample.cpuPercent;
  if (finiteNumber(sample.memUsedBytes)) out.memUsedBytes = sample.memUsedBytes;
  if (finiteNumber(sample.memTotalBytes)) out.memTotalBytes = sample.memTotalBytes;
  if (finiteNumber(sample.freeDiskBytes)) out.freeDiskBytes = sample.freeDiskBytes;
  return Object.keys(out).length > 1 ? out : null;
}

export function compactServerSample(sample: ServerUsageSample): ServerUsageSample | null {
  const out: ServerUsageSample = { t: sample.t };
  if (finiteNumber(sample.cpuPercent)) out.cpuPercent = sample.cpuPercent;
  if (finiteNumber(sample.memUsedBytes)) out.memUsedBytes = sample.memUsedBytes;
  return Object.keys(out).length > 1 ? out : null;
}

export function appendUsageHistory(
  prev: UsageHistory,
  host: HostUsageSample | null | undefined,
  servers?: Record<string, ServerUsageSample | null | undefined>,
  now = Date.now(),
): UsageHistory {
  const next: UsageHistory = {
    host: prev.host.slice(),
    servers: { ...prev.servers },
  };
  const hostSample = host ? compactHostSample({ ...host, t: host.t || now }) : null;
  if (hostSample) next.host = pushRing(next.host, hostSample);
  if (servers) {
    for (const [id, row] of Object.entries(servers)) {
      if (!id || !row) continue;
      const sample = compactServerSample({ ...row, t: row.t || now });
      if (!sample) continue;
      next.servers[id] = pushRing(next.servers[id] ?? [], sample);
    }
  }
  return next;
}

export function ramRatio(used?: number | null, total?: number | null): number | undefined {
  if (!finiteNumber(used) || !finiteNumber(total) || total <= 0) return undefined;
  return clamp01(used / total);
}

/** 0 = plenty free, 1 = critically low. No disk total required. */
export function diskPressure(freeBytes?: number | null): number | undefined {
  if (!finiteNumber(freeBytes) || freeBytes < 0) return undefined;
  if (freeBytes >= DISK_OK_BYTES) return 0.06;
  if (freeBytes <= DISK_LOW_BYTES) return 1;
  if (freeBytes <= DISK_WARN_BYTES) {
    return 0.72 + (1 - 0.72) * (1 - (freeBytes - DISK_LOW_BYTES) / (DISK_WARN_BYTES - DISK_LOW_BYTES));
  }
  return 0.06 + 0.66 * (1 - (freeBytes - DISK_WARN_BYTES) / (DISK_OK_BYTES - DISK_WARN_BYTES));
}

export function cpuTone(cpu?: number | null): UsageTone | undefined {
  if (!finiteNumber(cpu)) return undefined;
  if (cpu >= CPU_HIGH_PERCENT) return "danger";
  if (cpu >= CPU_WARN_PERCENT) return "warn";
  return "ok";
}

export function ramTone(used?: number | null, total?: number | null): UsageTone | undefined {
  const ratio = ramRatio(used, total);
  if (ratio == null) return undefined;
  if (ratio >= RAM_HIGH_RATIO) return "danger";
  if (ratio >= RAM_WARN_RATIO) return "warn";
  return "ok";
}

export function diskTone(freeBytes?: number | null): UsageTone | undefined {
  if (!finiteNumber(freeBytes)) return undefined;
  if (freeBytes < DISK_LOW_BYTES) return "danger";
  if (freeBytes < DISK_WARN_BYTES) return "warn";
  return "ok";
}

export function formatBytesShort(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib >= 10 ? gib.toFixed(0) : gib.toFixed(1)} GiB`;
  const mib = bytes / 1024 ** 2;
  return `${Math.max(0, Math.round(mib))} MiB`;
}

export function formatCpuShort(cpu: number): string {
  const n = Math.round(cpu * 10) / 10;
  return `${Number.isInteger(n) ? n.toFixed(0) : n.toFixed(1)}%`;
}

function seriesFrom<T>(
  history: T[],
  pick: (row: T) => number | null | undefined,
): Array<number | null> {
  return history.map((row) => {
    const v = pick(row);
    return finiteNumber(v) ? v : null;
  });
}

export function hostMeterRows(
  current: {
    cpuPercent?: number | null;
    memUsedBytes?: number | null;
    memTotalBytes?: number | null;
    freeDiskBytes?: number | null;
  },
  history: HostUsageSample[] = [],
): UsageMeterRow[] {
  const rows: UsageMeterRow[] = [];
  if (finiteNumber(current.cpuPercent)) {
    rows.push({
      key: "cpu",
      label: "CPU",
      value: formatCpuShort(current.cpuPercent),
      fill: clamp01(current.cpuPercent / 100),
      tone: cpuTone(current.cpuPercent) ?? "ok",
      series: seriesFrom(history, (s) =>
        finiteNumber(s.cpuPercent) ? clamp01(s.cpuPercent / 100) : null,
      ),
    });
  }
  const ratio = ramRatio(current.memUsedBytes, current.memTotalBytes);
  if (ratio != null && finiteNumber(current.memUsedBytes) && finiteNumber(current.memTotalBytes)) {
    rows.push({
      key: "ram",
      label: "RAM",
      value: `${formatBytesShort(current.memUsedBytes)} / ${formatBytesShort(current.memTotalBytes)}`,
      fill: ratio,
      tone: ramTone(current.memUsedBytes, current.memTotalBytes) ?? "ok",
      series: seriesFrom(history, (s) => ramRatio(s.memUsedBytes, s.memTotalBytes) ?? null),
    });
  } else if (finiteNumber(current.memUsedBytes)) {
    rows.push({
      key: "ram",
      label: "RAM",
      value: formatBytesShort(current.memUsedBytes),
      fill: 0.08,
      tone: "ok",
      series: seriesFrom(history, (s) => (finiteNumber(s.memUsedBytes) ? 0.08 : null)),
    });
  }
  if (finiteNumber(current.freeDiskBytes)) {
    rows.push({
      key: "disk",
      label: "Disk",
      value: `${formatBytesShort(current.freeDiskBytes)} free`,
      fill: diskPressure(current.freeDiskBytes) ?? 0,
      tone: diskTone(current.freeDiskBytes) ?? "ok",
      series: seriesFrom(history, (s) => diskPressure(s.freeDiskBytes) ?? null),
    });
  }
  return rows;
}

export function serverMeterRows(
  current: { cpuPercent?: number | null; memUsedBytes?: number | null },
  history: ServerUsageSample[] = [],
): UsageMeterRow[] {
  const rows: UsageMeterRow[] = [];
  if (finiteNumber(current.cpuPercent)) {
    rows.push({
      key: "cpu",
      label: "CPU",
      value: formatCpuShort(current.cpuPercent),
      fill: clamp01(current.cpuPercent / 100),
      tone: cpuTone(current.cpuPercent) ?? "ok",
      series: seriesFrom(history, (s) =>
        finiteNumber(s.cpuPercent) ? clamp01(s.cpuPercent / 100) : null,
      ),
    });
  }
  if (finiteNumber(current.memUsedBytes)) {
    rows.push({
      key: "ram",
      label: "RAM",
      value: formatBytesShort(current.memUsedBytes),
      fill: 0.08,
      tone: "ok",
      series: seriesFrom(history, (s) => (finiteNumber(s.memUsedBytes) ? 0.08 : null)),
    });
  }
  return rows;
}

function consecutiveDanger(history: HostUsageSample[], pick: (s: HostUsageSample) => UsageTone | undefined): boolean {
  if (history.length < 2) return false;
  const a = pick(history[history.length - 1]!);
  const b = pick(history[history.length - 2]!);
  return a === "danger" && b === "danger";
}

export function hostResourceAlerts(opts: {
  nodeId: string;
  nodeName: string;
  current: {
    cpuPercent?: number | null;
    memUsedBytes?: number | null;
    memTotalBytes?: number | null;
    freeDiskBytes?: number | null;
  };
  history?: HostUsageSample[];
}): ResourceAlert[] {
  const alerts: ResourceAlert[] = [];
  const name = opts.nodeName || opts.nodeId;
  const hist = opts.history ?? [];
  const disk = diskTone(opts.current.freeDiskBytes);
  if (disk === "danger" && finiteNumber(opts.current.freeDiskBytes)) {
    alerts.push({
      kind: "disk_low",
      tone: "danger",
      scope: "host",
      nodeId: opts.nodeId,
      nodeName: name,
      message: `${name} disk is low (${formatBytesShort(opts.current.freeDiskBytes)} free) — new installs will fail`,
    });
  } else if (disk === "warn" && finiteNumber(opts.current.freeDiskBytes)) {
    alerts.push({
      kind: "disk_low",
      tone: "warn",
      scope: "host",
      nodeId: opts.nodeId,
      nodeName: name,
      message: `${name} disk is getting tight (${formatBytesShort(opts.current.freeDiskBytes)} free)`,
    });
  }
  const cpu = cpuTone(opts.current.cpuPercent);
  if (cpu === "danger" && finiteNumber(opts.current.cpuPercent)) {
    const sustained = consecutiveDanger(hist, (s) => cpuTone(s.cpuPercent)) || opts.current.cpuPercent >= 95;
    alerts.push({
      kind: "cpu_high",
      tone: sustained ? "danger" : "warn",
      scope: "host",
      nodeId: opts.nodeId,
      nodeName: name,
      message: `${name} CPU is high (${formatCpuShort(opts.current.cpuPercent)})`,
    });
  }
  const ram = ramTone(opts.current.memUsedBytes, opts.current.memTotalBytes);
  if (ram === "danger" && finiteNumber(opts.current.memUsedBytes) && finiteNumber(opts.current.memTotalBytes)) {
    alerts.push({
      kind: "ram_high",
      tone: "danger",
      scope: "host",
      nodeId: opts.nodeId,
      nodeName: name,
      message: `${name} RAM is high (${formatBytesShort(opts.current.memUsedBytes)} / ${formatBytesShort(opts.current.memTotalBytes)})`,
    });
  }
  return alerts;
}

export function serverResourceAlerts(opts: {
  nodeId: string;
  nodeName: string;
  serverId: string;
  serverName: string;
  current: { cpuPercent?: number | null; memUsedBytes?: number | null };
}): ResourceAlert[] {
  const cpu = cpuTone(opts.current.cpuPercent);
  if (cpu !== "danger" || !finiteNumber(opts.current.cpuPercent)) return [];
  const game = opts.serverName || opts.serverId;
  const host = opts.nodeName || opts.nodeId;
  return [
    {
      kind: "cpu_high",
      tone: "danger",
      scope: "server",
      nodeId: opts.nodeId,
      nodeName: host,
      serverId: opts.serverId,
      serverName: game,
      message: `${game} on ${host} is hot (CPU ${formatCpuShort(opts.current.cpuPercent)})`,
    },
  ];
}

export function worstTone(tones: Array<UsageTone | undefined>): UsageTone | undefined {
  if (tones.includes("danger")) return "danger";
  if (tones.includes("warn")) return "warn";
  if (tones.includes("ok")) return "ok";
  return undefined;
}

/** Numbers stay off the face until hover or the sample is actually hot. */
export function usageValueVisible(tone: UsageTone, hovered = false): boolean {
  return hovered || tone === "warn" || tone === "danger";
}

export type SparkGeometry = {
  line: string;
  area: string;
  width: number;
  height: number;
};

/**
 * SVG paths for a 0–1 usage series. Empty / single-sample rings still
 * draw a plateau at `fallback` so quiet vs loaded is visible without history.
 */
export function usageSparkGeometry(
  series: Array<number | null | undefined>,
  fallback: number,
  width = 100,
  height = 28,
): SparkGeometry {
  const indexed = series
    .map((v, i) => (finiteNumber(v) ? { i, v: clamp01(v) } : null))
    .filter((p): p is { i: number; v: number } => p != null);
  const pts =
    indexed.length >= 2
      ? indexed
      : [
          { i: 0, v: clamp01(fallback) },
          { i: 1, v: clamp01(fallback) },
        ];
  const maxI = indexed.length >= 2 ? Math.max(series.length - 1, 1) : 1;
  const top = 1.5;
  const bot = height - 1.5;
  const span = Math.max(1, bot - top);
  const coords = pts.map((p) => ({
    x: (p.i / maxI) * width,
    y: bot - p.v * span,
  }));
  const line = coords
    .map((p, idx) => `${idx === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");
  const first = coords[0]!;
  const last = coords[coords.length - 1]!;
  const area = `${line} L${last.x.toFixed(1)} ${height.toFixed(1)} L${first.x.toFixed(1)} ${height.toFixed(1)} Z`;
  return { line, area, width, height };
}
