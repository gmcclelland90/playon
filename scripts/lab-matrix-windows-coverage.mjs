/**
 * Windows PE / Steam dual-place coverage summaries for lab-matrix.
 *
 * When playon-win-1 is offline (or PLAYON_MATRIX_WIN_NODE_ID=off), Windows-only
 * and PE skills skip with windows_only_pe / windows_only_depot /
 * unsupported_host_os. Those skips previously looked like a quiet green sweep.
 *
 * Env:
 *   PLAYON_MATRIX_WIN_SKIP_ALERT_THRESHOLD — min windows-coverage skips to alert
 *     when placement is off/unavailable (default 1). Set 0 to disable filing.
 */
export const WINDOWS_COVERAGE_SKIP_REASONS = Object.freeze([
  "windows_only_pe",
  "windows_only_depot",
  "unsupported_host_os",
]);

const REASON_SET = new Set(WINDOWS_COVERAGE_SKIP_REASONS);

export function windowsCoverageSkipThreshold() {
  const raw = process.env.PLAYON_MATRIX_WIN_SKIP_ALERT_THRESHOLD;
  if (raw == null || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 1;
  return Math.floor(n);
}

/**
 * @param {Array<{ skipped?: boolean, skipReason?: string, skillName?: string }>} results
 * @param {{ windowsPlacementEnabled?: boolean | null }} [opts]
 */
export function summarizeWindowsCoverage(results = [], opts = {}) {
  const byReason = Object.fromEntries(
    WINDOWS_COVERAGE_SKIP_REASONS.map((r) => [r, 0]),
  );
  /** @type {string[]} */
  const skills = [];
  for (const r of results) {
    if (!r?.skipped) continue;
    const reason = String(r.skipReason || "");
    if (!REASON_SET.has(reason)) continue;
    byReason[reason] = (byReason[reason] || 0) + 1;
    if (r.skillName) skills.push(r.skillName);
  }
  const skipCount = skills.length;
  const windowsPlacementEnabled =
    opts.windowsPlacementEnabled == null
      ? null
      : Boolean(opts.windowsPlacementEnabled);
  const threshold = windowsCoverageSkipThreshold();
  // Alert when dual-place is unavailable and PE/Windows skips accumulate.
  // threshold 0 disables the alert (docs / local dry runs).
  const alert =
    threshold > 0 &&
    windowsPlacementEnabled === false &&
    skipCount >= threshold;

  return {
    windowsPlacementEnabled,
    skipCount,
    byReason,
    skills,
    threshold,
    alert,
    summaryLine:
      `windows_pe_skips=${skipCount}` +
      ` pe=${byReason.windows_only_pe}` +
      ` depot=${byReason.windows_only_depot}` +
      ` unsupported_os=${byReason.unsupported_host_os}` +
      ` placement=${
        windowsPlacementEnabled == null
          ? "unknown"
          : windowsPlacementEnabled
            ? "on"
            : "off"
      }` +
      (alert ? " ALERT" : ""),
  };
}
