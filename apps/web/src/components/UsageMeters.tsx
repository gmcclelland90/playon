import type { HostUsageSample, ServerUsageSample, UsageMeterRow, UsageTone } from "@playon/shared";
import { hostMeterRows, serverMeterRows, usageSparkGeometry, worstTone } from "@playon/shared";

function AreaChart({
  series,
  fallback,
  tone,
  height,
}: {
  series: Array<number | null>;
  fallback: number;
  tone: UsageTone;
  height: number;
}) {
  const geo = usageSparkGeometry(series, fallback, 100, height);
  return (
    <svg
      className={`usage-spark tone-${tone}`}
      viewBox={`0 0 ${geo.width} ${geo.height}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <path className="usage-spark-area" d={geo.area} />
      <path className="usage-spark-line" d={geo.line} />
    </svg>
  );
}

function MeterRowView({ row, compact }: { row: UsageMeterRow; compact?: boolean }) {
  return (
    <div
      className={`usage-meter-row tone-${row.tone}`}
      data-meter={row.key}
      title={`${row.label} ${row.value}`}
      aria-label={`${row.label} ${row.value}`}
      tabIndex={0}
    >
      <span className="usage-meter-label">{row.label}</span>
      <span className="usage-meter-track" aria-hidden>
        <AreaChart series={row.series} fallback={row.fill} tone={row.tone} height={compact ? 28 : 36} />
      </span>
      <span className="usage-meter-value">{row.value}</span>
    </div>
  );
}

function UsageCluster({
  rows,
  compact,
  label,
}: {
  rows: UsageMeterRow[];
  compact?: boolean;
  label: string;
}) {
  if (!rows.length) return null;
  return (
    <div
      className={`usage-meters${compact ? " compact" : ""}`}
      role="group"
      aria-label={label}
    >
      {rows.map((row) => (
        <MeterRowView key={row.key} row={row} compact={compact} />
      ))}
    </div>
  );
}

function UsageStrip({ rows, label }: { rows: UsageMeterRow[]; label: string }) {
  if (!rows.length) return null;
  const hot = rows.find((r) => r.tone === "danger") ?? rows.find((r) => r.tone === "warn");
  return (
    <div className="usage-strip" role="group" aria-label={label}>
      {rows.map((row) => (
        <span
          key={row.key}
          className={`usage-strip-seg tone-${row.tone}`}
          title={`${row.label} ${row.value}`}
        >
          <AreaChart series={row.series} fallback={row.fill} tone={row.tone} height={20} />
        </span>
      ))}
      {hot ? <span className={`usage-strip-note tone-${hot.tone}`}>{hot.value}</span> : null}
    </div>
  );
}

export function HostUsageMeters(props: {
  cpuPercent?: number | null;
  memUsedBytes?: number | null;
  memTotalBytes?: number | null;
  freeDiskBytes?: number | null;
  history?: HostUsageSample[];
  compact?: boolean;
  variant?: "cluster" | "strip";
}) {
  const rows = hostMeterRows(props, props.history ?? []);
  if (props.variant === "strip") return <UsageStrip rows={rows} label="Host resource usage" />;
  return <UsageCluster rows={rows} compact={props.compact} label="Host resource usage" />;
}

export function ServerUsageMeters(props: {
  cpuPercent?: number | null;
  memUsedBytes?: number | null;
  history?: ServerUsageSample[];
  compact?: boolean;
  variant?: "cluster" | "strip";
}) {
  const rows = serverMeterRows(props, props.history ?? []);
  if (props.variant === "strip") return <UsageStrip rows={rows} label="Server resource usage" />;
  return <UsageCluster rows={rows} compact={props.compact} label="Server resource usage" />;
}

export function usageWorstTone(
  rows: Array<{ tone?: UsageTone } | undefined>,
): UsageTone | undefined {
  return worstTone(rows.map((r) => r?.tone));
}
