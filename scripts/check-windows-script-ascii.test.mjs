#!/usr/bin/env node
/**
 * The ASCII guard scans scripts this repo ships. A nested git checkout
 * (nightly's in-workspace playon-games) is another repository. A non-ASCII
 * script that belongs to this repo still fails, including under a directory
 * named playon-games when that directory is not its own checkout.
 *
 * Run: node scripts/check-windows-script-ascii.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findWindowsScripts, scanWindowsScripts } from "./check-windows-script-ascii.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dash = Buffer.from("REM Classic GoldSrc \u2014 not CS:S\r\n", "utf8");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-ascii-"));
try {
  const shipped = path.join(dir, "deploy", "windows");
  fs.mkdirSync(shipped, { recursive: true });
  fs.writeFileSync(path.join(shipped, "apply-self-update.ps1"), "Write-Host ok\r\n");
  fs.writeFileSync(path.join(dir, "tools.cmd"), "@echo off\r\n");

  const nested = path.join(dir, "other-repo", "files");
  fs.mkdirSync(path.join(dir, "other-repo", ".git"), { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, "start.ps1"), dash);

  const unpacked = path.join(dir, "playon-games", "files");
  fs.mkdirSync(unpacked, { recursive: true });
  fs.writeFileSync(path.join(unpacked, "start.bat"), dash);

  const rel = (file) => path.relative(dir, file).split(path.sep).join("/");
  const found = findWindowsScripts(dir).map(rel).sort();
  assert.deepEqual(found, [
    "deploy/windows/apply-self-update.ps1",
    "playon-games/files/start.bat",
    "tools.cmd",
  ]);

  const scan = scanWindowsScripts(dir);
  assert.deepEqual(
    scan.failures.map((failure) => rel(failure.file)),
    ["playon-games/files/start.bat"],
  );
  assert.equal(scan.failures[0].count, 3);
  assert.ok(scan.failures[0].first > 0);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

const live = scanWindowsScripts(repoRoot);
assert.equal(live.failures.length, 0);
assert.ok(
  live.files.some((file) => file.endsWith(path.join("deploy", "windows", "apply-self-update.ps1"))),
);

const workflow = fs.readFileSync(
  path.join(repoRoot, ".github/workflows/nightly-docker.yml"),
  "utf8",
);
assert.match(workflow, /dest="\$GITHUB_WORKSPACE\/\.\.\/playon-games"/);
assert.match(workflow, /mv "\$src" "\$dest"/);
assert.match(
  workflow,
  /PLAYON_GAMES_SKILLS_ROOT: \$\{\{ github\.workspace \}\}\/\.\.\/playon-games\/skills-src\/games/,
);

const parseScript = fs.readFileSync(
  path.join(repoRoot, "scripts/check-windows-ps1-parse.ps1"),
  "utf8",
);
assert.match(parseScript, /Join-Path \$item\.FullName "\.git"/);

console.log("ok check-windows-script-ascii.test.mjs");
