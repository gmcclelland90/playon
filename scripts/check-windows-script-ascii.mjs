#!/usr/bin/env node
/**
 * Fail if a Windows script in this repo contains a non-ASCII byte.
 *
 * Windows PowerShell 5.1 reads a no-BOM script as the ANSI code page.
 * UTF-8 em dash bytes E2 80 94 become a cp1252 smart quote and the file
 * fails to parse (#1060). ASCII parses the same way on 5.1 and PowerShell 7.
 *
 * deploy/ is copied into the Home and node packages. Other .ps1/.cmd/.bat
 * files in the repo are host scripts and have the same parser.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set([
  "node_modules",
  "dist",
  "dist-home",
  "dist-node",
  "dist-package",
  ".git",
  "tmp",
  "coverage",
  ".turbo",
  "out",
]);
const EXTS = new Set([".ps1", ".psm1", ".cmd", ".bat"]);

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (EXTS.has(path.extname(ent.name).toLowerCase())) out.push(full);
  }
  return out;
}

const files = walk(root);
const applyHelper = path.join("deploy", "windows", "apply-self-update.ps1");
if (!files.some((file) => file.endsWith(applyHelper))) {
  console.error("check-windows-script-ascii: apply-self-update.ps1 was not scanned");
  process.exit(1);
}

let failed = false;
for (const file of files) {
  const buf = fs.readFileSync(file);
  let first = -1;
  let count = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] > 127) {
      if (first < 0) first = i;
      count++;
    }
  }
  if (count > 0) {
    failed = true;
    console.error(`${path.relative(root, file)}: ${count} non-ASCII byte(s), first at offset ${first}`);
  }
}

if (failed) {
  console.error("Windows scripts must be ASCII so PowerShell 5.1 can parse them (#1060).");
  process.exit(1);
}

console.log(`check-windows-script-ascii: ${files.length} script(s) ok`);
