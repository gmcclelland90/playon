#!/usr/bin/env node
/**
 * A red unit layer must name the failing test even when that line is not in
 * the last 40 lines of the layer log.
 *
 * Run: node scripts/agent-dev-loop.test.mjs
 */
import assert from "node:assert/strict";
import { extractFailureLines, formatFailureReport } from "./agent-dev-loop.mjs";
import { verifySummaryLine } from "./lab-report.mjs";

const buried = [
  "FAIL check-windows-script-ascii",
  "playon-games/packages-src/games/cs-1-6/files/start.bat: 9 non-ASCII byte(s), first at offset 105",
  ...Array.from({ length: 45 }, (_, i) => `game-${i}/start.bat: 3 non-ASCII byte(s), first at offset 10`),
  "Windows scripts must be ASCII so PowerShell 5.1 can parse them (#1060).",
  ...Array.from({ length: 50 }, () => "turbo noise that is not a failure"),
].join("\n");

const tailOnly = buried.split("\n").slice(-40).join("\n");
assert.equal(tailOnly.includes("FAIL check-windows-script-ascii"), false);

const named = extractFailureLines(buried);
assert.equal(named[0], "FAIL check-windows-script-ascii");
assert.ok(named.some((line) => line.includes("non-ASCII byte")));
assert.ok(named.some((line) => line.includes("Windows scripts must be ASCII")));
assert.ok(named.some((line) => line.startsWith("… ")));

const report = formatFailureReport(buried, { command: "pnpm test:unit" });
assert.match(report, /^command: pnpm test:unit/);
assert.match(report, /failing tests:\nFAIL check-windows-script-ascii/);

const vitest = [
  " ✓ passes",
  "   × writes the start marker",
  " FAIL  src/ota.test.ts > apply > writes the start marker",
  "AssertionError: expected true to be false",
  " Test Files  1 failed | 4 passed (5)",
  "      Tests  1 failed | 20 passed (21)",
  " ELIFECYCLE  Command failed with exit code 1.",
].join("\n");
const vitestNames = extractFailureLines(vitest);
assert.ok(vitestNames.some((line) => line.includes("× writes the start marker")));
assert.ok(vitestNames.some((line) => line.includes("FAIL  src/ota.test.ts > apply > writes the start marker")));
assert.ok(vitestNames.some((line) => line.includes("AssertionError")));
assert.ok(vitestNames.some((line) => /Test Files/.test(line) && /failed/.test(line)));
assert.ok(vitestNames.some((line) => line.includes("ELIFECYCLE")));

const summary = verifySummaryLine(
  {
    ok: false,
    failedLayer: "unit",
    results: [
      {
        name: "unit",
        ok: false,
        failingTests: [
          "FAIL check-windows-script-ascii",
          "deploy/windows/apply-self-update.ps1: 3 non-ASCII byte(s), first at offset 12",
        ],
      },
    ],
  },
  { done: 0, requested: 0, fail: 0 },
);
assert.match(summary, /^verify=red layer=unit failing=FAIL check-windows-script-ascii/);
assert.match(summary, /matrix=0\/0 fail=0$/);
assert.match(
  verifySummaryLine({ ok: true, failedLayer: null, results: [] }, { done: 1, requested: 1, fail: 0 }),
  /^verify=green matrix=1\/1 fail=0$/,
);

console.log("ok agent-dev-loop.test.mjs");
