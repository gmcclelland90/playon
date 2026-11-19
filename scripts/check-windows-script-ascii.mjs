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
 *
 * A child directory with its own .git is a separate checkout. nightly-docker
 * checks playon-games out inside the workspace so paper smoke can load catalog
 * skills; those start scripts are not packaged with Home. Regular CI does not
 * check that repo out, and the lab host keeps it as a sibling, so only the
 * in-workspace layout was failing this guard.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SKIP_DIR_NAMES = new Set([
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

export function isNestedCheckout(dir) {
  return fs.existsSync(path.join(dir, ".git"));
}

export function findWindowsScripts(rootDir) {
  const out = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIR_NAMES.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (isNestedCheckout(full)) continue;
        walk(full);
      } else if (EXTS.has(path.extname(ent.name).toLowerCase())) {
        out.push(full);
      }
    }
  }
  walk(rootDir);
  return out;
}

export function nonAsciiHits(buf) {
  let first = -1;
  let count = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] > 127) {
      if (first < 0) first = i;
      count++;
    }
  }
  return { count, first };
}

export function scanWindowsScripts(rootDir) {
  const files = findWindowsScripts(rootDir);
  const failures = [];
  for (const file of files) {
    const hit = nonAsciiHits(fs.readFileSync(file));
    if (hit.count > 0) failures.push({ file, ...hit });
  }
  return { files, failures };
}

function main() {
  const { files, failures } = scanWindowsScripts(root);
  const applyHelper = path.join("deploy", "windows", "apply-self-update.ps1");
  if (!files.some((file) => file.endsWith(applyHelper))) {
    console.error("FAIL check-windows-script-ascii");
    console.error("check-windows-script-ascii: apply-self-update.ps1 was not scanned");
    process.exit(1);
  }

  if (failures.length > 0) {
    console.error("FAIL check-windows-script-ascii");
    for (const failure of failures) {
      const rel = path.relative(root, failure.file);
      console.error(
        `${rel}: ${failure.count} non-ASCII byte(s), first at offset ${failure.first}`,
      );
    }
    console.error("Windows scripts must be ASCII so PowerShell 5.1 can parse them (#1060).");
    process.exit(1);
  }

  console.log(`check-windows-script-ascii: ${files.length} script(s) ok`);
}

const invokedAsCli =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (invokedAsCli) main();
