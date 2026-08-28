/** Shared operator-facing resource labels. Missing fields are omitted. */

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(1)} GiB`;
  const mib = bytes / 1024 ** 2;
  return `${mib.toFixed(0)} MiB`;
}

export function formatCpuPercent(cpu: number | null | undefined): string | null {
  if (cpu == null || !Number.isFinite(cpu)) return null;
  const n = Math.round(cpu * 10) / 10;
  return `${Number.isInteger(n) ? n.toFixed(0) : n.toFixed(1)}%`;
}

export type HostUsageInput = {
  cpuPercent?: number | null;
  memUsedBytes?: number | null;
  memTotalBytes?: number | null;
  freeDiskBytes?: number | null;
};

export type ServerUsageInput = {
  cpuPercent?: number | null;
  memUsedBytes?: number | null;
};

export function formatHostUsage(n: HostUsageInput): string | null {
  const bits: string[] = [];
  const cpu = formatCpuPercent(n.cpuPercent);
  if (cpu) bits.push(`CPU ${cpu}`);
  if (n.memUsedBytes != null && n.memTotalBytes != null && n.memTotalBytes > 0) {
    bits.push(`RAM ${formatBytes(n.memUsedBytes)} / ${formatBytes(n.memTotalBytes)}`);
  } else if (n.memUsedBytes != null) {
    bits.push(`RAM ${formatBytes(n.memUsedBytes)}`);
  }
  if (n.freeDiskBytes != null) bits.push(`${formatBytes(n.freeDiskBytes)} free`);
  return bits.length ? bits.join(" · ") : null;
}

export function formatServerUsage(s: ServerUsageInput): string | null {
  const bits: string[] = [];
  const cpu = formatCpuPercent(s.cpuPercent);
  if (cpu) bits.push(cpu);
  if (s.memUsedBytes != null) bits.push(formatBytes(s.memUsedBytes));
  return bits.length ? bits.join(" · ") : null;
}

export type UsageChip = { label: string };

/** Settings → Nodes chips. Older agents only contribute disk. */
export function nodeUsageChips(n: HostUsageInput): UsageChip[] {
  const chips: UsageChip[] = [];
  const cpu = formatCpuPercent(n.cpuPercent);
  if (cpu) chips.push({ label: `CPU ${cpu}` });
  if (n.memUsedBytes != null && n.memTotalBytes != null && n.memTotalBytes > 0) {
    chips.push({ label: `${formatBytes(n.memUsedBytes)} / ${formatBytes(n.memTotalBytes)}` });
  }
  if (n.freeDiskBytes != null) chips.push({ label: `${formatBytes(n.freeDiskBytes)} free` });
  return chips;
}
