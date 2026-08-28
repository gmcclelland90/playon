import type { HostUsageSample, ServerUsageSample, UsageMeterRow, UsageTone } from "@playon/shared";
import { hostMeterRows, serverMeterRows } from "@playon/shared";

function Sparkline({ series, tone }: { series: Array<number | null>; tone: UsageTone }) {
  const pts = series
    .map((v, i) => (v == null ? null : { i, v }))
    .filter((p): p is { i: number; v: number } => p != null);
  if (pts.length < 2) return null;
  const w = 42;
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
    <svg className="usage-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.25" className={`tone-${tone}`} />
    </svg>
  );
}

function MeterRowView({ row }: { row: UsageMeterRow }) {
  return (
    <div className={`usage-meter-row tone-${row.tone}`} data-meter={row.key}>
      <span className="usage-meter-label">{row.label}</span>
      <span className="usage-meter-track" aria-hidden>
        <span className="usage-meter-fill" style={{ width: `${Math.max(4, row.fill * 100)}%` }} />
      </span>
      <span className="usage-meter-value">{row.value}</span>
      <Sparkline series={row.series} tone={row.tone} />
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
}) {
  const rows = hostMeterRows(props, props.history ?? []);
  if (!rows.length) return null;
  return (
    <div
      className={`usage-meters${props.compact ? " compact" : ""}`}
      role="group"
      aria-label="Host resource usage"
    >
      {rows.map((row) => (
        <MeterRowView key={row.key} row={row} />
      ))}
    </div>
  );
}

export function ServerUsageMeters(props: {
  cpuPercent?: number | null;
  memUsedBytes?: number | null;
  history?: ServerUsageSample[];
  compact?: boolean;
}) {
  const rows = serverMeterRows(props, props.history ?? []);
  if (!rows.length) return null;
  return (
    <div
      className={`usage-meters${props.compact ? " compact" : ""}`}
      role="group"
      aria-label="Server resource usage"
    >
      {rows.map((row) => (
        <MeterRowView key={row.key} row={row} />
      ))}
    </div>
  );
}
