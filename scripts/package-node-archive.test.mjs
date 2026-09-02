#!/usr/bin/env node
/**
 * Unit tests for Windows/Linux node tarball create args.
 * Run: node scripts/package-node-archive.test.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { linuxNodeTarCreate, windowsNodeTarCreate } from "./package-node-archive.mjs";

const archiveName = "playon-node-0.2.6-windows-x64.tar.gz";
const winOut = "D:\\a\\playon\\playon\\dist-node";
const winPlan = windowsNodeTarCreate({ archiveName, outDir: winOut });

assert.equal(winPlan.cmd, "tar");
assert.ok(!winPlan.args.includes("--force-local"), "Windows create must not pass --force-local (bsdtar)");
assert.deepEqual(winPlan.args, ["-czf", archiveName, "-C", ".", "playon-node"]);
assert.equal(winPlan.cwd, winOut);
assert.ok(!winPlan.args.includes(winOut), "Windows tar -f/-C must not use an absolute D: path");
assert.ok(!winPlan.args.some((a) => a.includes(":")), "Windows tar args must not include a drive colon");

assert.throws(
  () => windowsNodeTarCreate({ archiveName: path.join(winOut, archiveName), outDir: winOut }),
  /relative filename/,
);

const linuxPath = "/workspace/dist-node/playon-node-0.2.6-linux-x64.tar.gz";
const linuxPlan = linuxNodeTarCreate({
  archivePath: linuxPath,
  outDir: "/workspace/dist-node",
});
assert.equal(linuxPlan.cmd, "tar");
assert.deepEqual(linuxPlan.args, ["-czf", linuxPath, "-C", "/workspace/dist-node", "playon-node"]);

const src = fs.readFileSync(fileURLToPath(new URL("./package-node.mjs", import.meta.url)), "utf8");
assert.ok(src.includes("windowsNodeTarCreate"), "package-node.mjs must use windowsNodeTarCreate");
assert.ok(
  src.includes("bundledWindowsStartNodeCmd"),
  "package-node.mjs must ship start-node.cmd from bundledWindowsStartNodeCmd (call node.env.cmd)",
);
assert.ok(
  src.includes("windowsLoadEnvCjsSource"),
  "package-node.mjs must ship load-env.cjs so the task can exec node.exe without cmd.exe",
);
assert.ok(
  !src.includes('"%~dp0runtime\\\\node\\\\node.exe" "%~dp0apps\\\\node-agent\\\\dist\\\\index.js"'),
  "package-node.mjs must not ship the vintage start-node.cmd that skipped node.env.cmd",
);
assert.ok(
  !/execFileSync\(\s*["']tar["'][\s\S]*--force-local/.test(src),
  "package-node.mjs must not pass --force-local to tar",
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-tar-"));
try {
  const stage = path.join(tmp, "playon-node");
  fs.mkdirSync(stage);
  fs.writeFileSync(path.join(stage, "INSTALL.md"), "ok\n");
  const live = windowsNodeTarCreate({ archiveName, outDir: tmp });
  execFileSync(live.cmd, live.args, { cwd: live.cwd });
  const tarball = path.join(tmp, archiveName);
  assert.ok(fs.existsSync(tarball), "relative -f create must write the tarball in outDir");
  const listing = execFileSync("tar", ["-tzf", archiveName], { cwd: tmp, encoding: "utf8" });
  assert.ok(listing.includes("playon-node/INSTALL.md"), listing);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("package-node-archive.test.mjs: ok");
