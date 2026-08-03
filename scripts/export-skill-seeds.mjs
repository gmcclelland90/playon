#!/usr/bin/env node
/**
 * Pack catalog skill sources into the playon.games library.
 *
 * Usage:
 *   node scripts/export-skill-seeds.mjs
 *   node scripts/export-skill-seeds.mjs games.valheim games.terraria
 *
 * Source: sites/playon-games/skills/src/**
 * Writes:
 *   sites/playon-games/skills/packages/{slug}-{version}.skill.zip
 *   sites/playon-games/skills/index.json  (absolute https://playon.games URLs)
 *   dist/skills/                         (mirror for local inspection)
 *
 * Platform skills stay in Home (skills/platform). Game skills are catalog-only.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(path.join(repoRoot, "apps/api/package.json"));
const { zipSync } = require("fflate");
const yaml = require("js-yaml");

const SITE_SKILLS = path.join(repoRoot, "sites", "playon-games", "skills");
const SRC = path.join(SITE_SKILLS, "src");
const PACKAGES = path.join(SITE_SKILLS, "packages");
const DIST = path.join(repoRoot, "dist", "skills");
const CATALOG_BASE = "https://playon.games/skills/packages";
const INDEX_PATH = path.join(SITE_SKILLS, "index.json");

const nameFilter = new Set(
  process.argv.slice(2).map((s) => s.trim()).filter(Boolean),
);

function walkFiles(dir, prefix = "") {
  const out = {};
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const abs = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = fs.statSync(abs);
    if (st.isDirectory()) Object.assign(out, walkFiles(abs, rel));
    else if (st.isFile()) out[rel.replace(/\\/g, "/")] = new Uint8Array(fs.readFileSync(abs));
  }
  return out;
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

function scan(root) {
  const found = [];
  if (!fs.existsSync(root)) return found;
  const walk = (dir) => {
    const meta = path.join(dir, "metadata.yaml");
    if (fs.existsSync(meta)) {
      found.push(dir);
      return;
    }
    for (const name of fs.readdirSync(dir)) {
      const child = path.join(dir, name);
      if (fs.statSync(child).isDirectory()) walk(child);
    }
  };
  walk(root);
  return found;
}

function loadExistingIndex() {
  if (!fs.existsSync(INDEX_PATH)) return { updatedAt: "", skills: [] };
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  } catch {
    return { updatedAt: "", skills: [] };
  }
}

function entryFromMeta(raw, filename, sha256) {
  const name = String(raw.name ?? "");
  const version = String(raw.version ?? "0.0.0");
  /** @type {Record<string, unknown>} */
  const entry = {
    name,
    version,
    description: String(raw.description ?? "").trim(),
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    dependencies: Array.isArray(raw.dependencies) ? raw.dependencies : [],
    downloadUrl: `${CATALOG_BASE}/${filename}`,
    sha256,
    official: true,
  };
  if (raw.game) entry.game = String(raw.game);
  if (raw.containerSupport) entry.containerSupport = String(raw.containerSupport);
  if (typeof raw.minRamMb === "number") entry.minRamMb = raw.minRamMb;
  if (raw.steamAppId != null) entry.steamAppId = raw.steamAppId;
  if (raw.dockerImage) entry.dockerImage = String(raw.dockerImage);
  return entry;
}

fs.mkdirSync(PACKAGES, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });

const byName = new Map();
for (const s of loadExistingIndex().skills ?? []) {
  if (s?.name) byName.set(s.name, s);
}

let wrote = 0;

for (const skillDir of scan(SRC)) {
  const raw = yaml.load(fs.readFileSync(path.join(skillDir, "metadata.yaml"), "utf8"));
  const name = String(raw.name ?? "");
  const version = String(raw.version ?? "0.0.0");
  if (!name.startsWith("games.")) continue;
  if (nameFilter.size && !nameFilter.has(name)) continue;

  const files = walkFiles(skillDir);
  if (!files["metadata.yaml"]) throw new Error(`missing metadata in ${skillDir}`);
  const bytes = zipSync(files, { level: 6 });
  const filename = `${slugify(name)}-${version}.skill.zip`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  fs.writeFileSync(path.join(PACKAGES, filename), bytes);
  fs.writeFileSync(path.join(DIST, filename), bytes);

  byName.set(name, entryFromMeta(raw, filename, sha256));
  wrote += 1;
  console.log(`wrote ${filename}`);
}

if (nameFilter.size && wrote === 0) {
  console.error(`No matching games.* skills for: ${[...nameFilter].join(", ")}`);
  process.exit(1);
}

const index = {
  updatedAt: new Date().toISOString(),
  skills: [...byName.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))),
};

const indexJson = JSON.stringify(index, null, 2) + "\n";
fs.writeFileSync(INDEX_PATH, indexJson);
fs.writeFileSync(path.join(DIST, "index.json"), indexJson);
console.log(`index: ${index.skills.length} skills → ${INDEX_PATH} (${wrote} packed this run)`);
