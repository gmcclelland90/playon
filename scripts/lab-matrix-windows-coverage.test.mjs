#!/usr/bin/env node
/**
 * Unit tests for Windows PE / dual-place coverage summaries (#46).
 * Run: node scripts/lab-matrix-windows-coverage.test.mjs
 */
import assert from "node:assert/strict";
import {
  WINDOWS_COVERAGE_SKIP_REASONS,
  summarizeWindowsCoverage,
  windowsCoverageSkipThreshold,
} from "./lab-matrix-windows-coverage.mjs";

assert.deepEqual(WINDOWS_COVERAGE_SKIP_REASONS, [
  "windows_only_pe",
  "windows_only_depot",
  "unsupported_host_os",
]);

delete process.env.PLAYON_MATRIX_WIN_SKIP_ALERT_THRESHOLD;
assert.equal(windowsCoverageSkipThreshold(), 1);

process.env.PLAYON_MATRIX_WIN_SKIP_ALERT_THRESHOLD = "0";
assert.equal(windowsCoverageSkipThreshold(), 0);
process.env.PLAYON_MATRIX_WIN_SKIP_ALERT_THRESHOLD = "3";
assert.equal(windowsCoverageSkipThreshold(), 3);
delete process.env.PLAYON_MATRIX_WIN_SKIP_ALERT_THRESHOLD;

const empty = summarizeWindowsCoverage([], { windowsPlacementEnabled: false });
assert.equal(empty.skipCount, 0);
assert.equal(empty.alert, false);
assert.match(empty.summaryLine, /windows_pe_skips=0/);
assert.match(empty.summaryLine, /placement=off/);

const mixed = summarizeWindowsCoverage(
  [
    { ok: true, skipped: false, skillName: "games.minecraft-paper" },
    {
      ok: true,
      skipped: true,
      skipReason: "windows_only_pe",
      skillName: "games.stormworks",
    },
    {
      ok: true,
      skipped: true,
      skipReason: "windows_only_depot",
      skillName: "games.valheim",
    },
    {
      ok: true,
      skipped: true,
      skipReason: "unsupported_host_os",
      skillName: "games.squad",
    },
    {
      ok: true,
      skipped: true,
      skipReason: "steamcmd_no_subscription",
      skillName: "games.arma3",
    },
  ],
  { windowsPlacementEnabled: false },
);
assert.equal(mixed.skipCount, 3);
assert.equal(mixed.byReason.windows_only_pe, 1);
assert.equal(mixed.byReason.windows_only_depot, 1);
assert.equal(mixed.byReason.unsupported_host_os, 1);
assert.equal(mixed.alert, true);
assert.match(mixed.summaryLine, /ALERT/);
assert.deepEqual(mixed.skills, [
  "games.stormworks",
  "games.valheim",
  "games.squad",
]);

const placementOn = summarizeWindowsCoverage(
  [
    {
      ok: true,
      skipped: true,
      skipReason: "windows_only_pe",
      skillName: "games.stormworks",
    },
  ],
  { windowsPlacementEnabled: true },
);
assert.equal(placementOn.skipCount, 1);
assert.equal(placementOn.alert, false);

process.env.PLAYON_MATRIX_WIN_SKIP_ALERT_THRESHOLD = "0";
const disabled = summarizeWindowsCoverage(
  [
    {
      ok: true,
      skipped: true,
      skipReason: "windows_only_pe",
      skillName: "games.stormworks",
    },
  ],
  { windowsPlacementEnabled: false },
);
assert.equal(disabled.alert, false);
delete process.env.PLAYON_MATRIX_WIN_SKIP_ALERT_THRESHOLD;

console.log("lab-matrix-windows-coverage.test.mjs: ok");
