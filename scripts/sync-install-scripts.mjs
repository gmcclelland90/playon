#!/usr/bin/env node
/**
 * Copy deploy/bootstrap installers into sibling playon-games/public for playon.games hosting.
 *   node scripts/sync-install-scripts.mjs
 *
 * Env:
 *   PLAYON_GAMES_PUBLIC  override path to playon-games/public (CI when playon is nested)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const site =
  process.env.PLAYON_GAMES_PUBLIC?.trim() ||
  path.resolve(root, "..", "playon-games", "public");

const pairs = [
  [path.join(root, "deploy/bootstrap/install.ps1"), path.join(site, "install.ps1")],
  [path.join(root, "deploy/bootstrap/install.sh"), path.join(site, "install")],
  [path.join(root, "deploy/install-node.sh"), path.join(site, "install-node")],
  [path.join(root, "deploy/lib/ensure-docker.sh"), path.join(site, "ensure-docker")],
];

if (!fs.existsSync(site)) {
  console.error(`playon-games public/ not found at ${site}`);
  process.exit(1);
}

for (const [from, to] of pairs) {
  fs.copyFileSync(from, to);
  console.log(`${path.relative(root, from)} → ${to}`);
}
