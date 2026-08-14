#!/usr/bin/env node
/**
 * Build playon.games/home/latest.json from local Home/Node package artifacts.
 *
 * Looks for:
 *   dist-home/playon-home-<ver>-{linux,windows}-x64.{tar.gz,zip}
 *   dist-node/playon-node-<ver>-{linux,windows}-x64.{tar.gz,zip}
 *
 * Env:
 *   PLAYON_RELEASE_TAG     e.g. v0.1.5 (default: v{version from package.json})
 *   PLAYON_GITHUB_REPO     default gmcclelland90/playon
 *   PLAYON_GAMES_PUBLIC    override path to playon-games/public
 *   PLAYON_MANIFEST_STRICT 1 (default) — require all four platform assets; set 0 to allow partial
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const tag = (process.env.PLAYON_RELEASE_TAG?.trim() || `v${version}`).replace(/^v/, "");
const tagName = `v${tag}`;
const repo = process.env.PLAYON_GITHUB_REPO?.trim() || "gmcclelland90/playon";
const gamesPublic =
  process.env.PLAYON_GAMES_PUBLIC?.trim() ||
  path.resolve(root, "..", "playon-games", "public");
const strict = process.env.PLAYON_MANIFEST_STRICT !== "0";

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function releaseUrl(filename) {
  return `https://github.com/${repo}/releases/download/${tagName}/${filename}`;
}

function findAsset(dir, kind, platform) {
  // Must match preferredUpdateAssetExtensions in packages/shared/src/update-extract.ts
  const exts = platform.startsWith("windows")
    ? kind === "node"
      ? ["tar.gz", "zip"]
      : ["zip", "tar.gz"]
    : ["tar.gz", "zip"];
  for (const ext of exts) {
    const name = `playon-${kind}-${version}-${platform}.${ext}`;
    const full = path.join(dir, name);
    if (fs.existsSync(full)) return { name, full };
  }
  return null;
}

function collect(kind, dirs) {
  /** @type {Record<string, { downloadUrl: string, sha256: string, size: number }>} */
  const out = {};
  for (const platform of ["linux-x64", "windows-x64"]) {
    let found = null;
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      found = findAsset(dir, kind, platform);
      if (found) break;
      for (const ent of fs.readdirSync(dir)) {
        if (ent.startsWith(`playon-${kind}-${version}-${platform}.`)) {
          found = { name: ent, full: path.join(dir, ent) };
          break;
        }
      }
      if (found) break;
    }
    if (!found) {
      console.warn(`warn: missing ${kind} asset for ${platform}`);
      continue;
    }
    const sha256 = sha256File(found.full);
    const size = fs.statSync(found.full).size;
    out[platform] = {
      downloadUrl: releaseUrl(found.name),
      sha256,
      size,
    };
    console.log(`${found.name}  sha256=${sha256.slice(0, 12)}…  ${size} bytes`);
  }
  return out;
}

function walkArtifactDirs(base) {
  const dirs = [base];
  if (!fs.existsSync(base)) return dirs;
  for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
    if (ent.isDirectory()) dirs.push(path.join(base, ent.name));
  }
  return dirs;
}

const homeDirs = [
  path.join(root, "dist-home"),
  ...walkArtifactDirs(path.join(root, "artifacts")),
];
const nodeDirs = [
  path.join(root, "dist-node"),
  ...walkArtifactDirs(path.join(root, "artifacts")),
];

const home = collect("home", homeDirs);
const node = collect("node", nodeDirs);

const required = [
  ["home", "linux-x64"],
  ["home", "windows-x64"],
  ["node", "linux-x64"],
  ["node", "windows-x64"],
];
const missing = required.filter(([kind, plat]) => !(kind === "home" ? home : node)[plat]);
if (strict && missing.length) {
  console.error(
    `error: incomplete update manifest (missing ${missing.map(([k, p]) => `${k}/${p}`).join(", ")}). ` +
      `Place all four release archives under dist-home/ and dist-node/, or set PLAYON_MANIFEST_STRICT=0.`,
  );
  process.exit(1);
}

const manifest = {
  updatedAt: new Date().toISOString(),
  version,
  channel: "stable",
  notesUrl: "https://playon.games/docs/changelog",
  minHomeVersion: "0.1.0",
  home,
  node,
};

const outDir = path.join(gamesPublic, "home");
fs.mkdirSync(outDir, { recursive: true });
const latestPath = path.join(outDir, "latest.json");
fs.writeFileSync(latestPath, JSON.stringify(manifest, null, 2) + "\n");
fs.writeFileSync(path.join(outDir, `${version}.json`), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Wrote ${latestPath}`);
console.log(`version=${version} tag=${tagName} platforms home=${Object.keys(home).join(",")} node=${Object.keys(node).join(",")}`);
