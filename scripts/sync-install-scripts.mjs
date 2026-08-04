#!/usr/bin/env node
/**
 * Copy deploy/bootstrap installers into sibling playon-games/public for playon.games hosting.
 *   node scripts/sync-install-scripts.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const site = path.resolve(root, "..", "playon-games", "public");

const pairs = [
  [path.join(root, "deploy/bootstrap/install.ps1"), path.join(site, "install.ps1")],
  [path.join(root, "deploy/bootstrap/install.sh"), path.join(site, "install")],
];

if (!fs.existsSync(site)) {
  console.error(`playon-games public/ not found at ${site}`);
  process.exit(1);
}

for (const [from, to] of pairs) {
  fs.copyFileSync(from, to);
  console.log(`${path.relative(root, from)} → ${to}`);
}
