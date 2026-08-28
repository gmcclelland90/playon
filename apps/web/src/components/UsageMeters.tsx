import type { HostUsageSample, ServerUsageSample, UsageMeterRow, UsageTone } from "@playon/shared";
import { hostMeterRows, serverMeterRows, worstTone } from "@playon/shared";

function Sparkline({ series, tone }: { series: Array<number | null>; tone: UsageTone }) {
  const pts = series
    .map((v, i) => (v == null ? null : { i, v }))
    .filter((p): p is { i: number; v: number } => p != null);
  if (pts.length < 3) return null;
  const w = 100;
  const h = 12;
  const maxI = Math.max(series.length - 1, 1);
  const d = pts
    .map((p, idx) => {
      const x = (p.i / maxI) * w;
      const y = h - 1 - p.v * (h - 2);
      return `${idx === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className={`usage-spark tone-${tone}`} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function MeterRowView({ row, showHistory }: { row: UsageMeterRow; showHistory: boolean }) {
  return (
    <div
      className={`usage-meter-row tone-${row.tone}`}
      data-meter={row.key}
      aria-label={`${row.label} ${row.value}`}
    >
      <span className="usage-meter-label">{row.label}</span>
      <span className="usage-meter-track" aria-hidden>
        <span className="usage-meter-fill" style={{ width: `${Math.max(4, row.fill * 100)}%` }} />
        {showHistory ? <Sparkline series={row.series} tone={row.tone} /> : null}
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
        <MeterRowView key={row.key} row={row} showHistory={!compact} />
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
          <span className="usage-strip-fill" style={{ width: `${Math.max(8, row.fill * 100)}%` }} />
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
