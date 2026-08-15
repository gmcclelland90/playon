"use strict";
/**
 * CommonJS spawn helper for Windows self-update (#885).
 * 0.2.3/0.2.4 called `require("node:child_process")` from ESM (`"type": "module"`)
 * and failed with `require is not defined`. This file is `.cjs` so require() is
 * defined. Home's vintage bootstrap does not load this; it is the ESM-safe
 * equivalent of that 0.2.3 line for current / future helpers.
 */
const { spawn } = require("node:child_process");

const helperScript = process.argv[2];
if (!helperScript) {
  process.stderr.write("usage: spawn-apply-update.cjs <apply-self-update.ps1> [args...]\n");
  process.exit(2);
}
const helperArgs = process.argv.slice(3);
const child = spawn(
  "powershell.exe",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helperScript, ...helperArgs],
  { detached: true, stdio: "ignore", windowsHide: true },
);
child.unref();
