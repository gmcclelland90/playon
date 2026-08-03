#!/usr/bin/env node
/**
 * Pack repo skills into dist/skills/*.skill.zip for the playon.games library.
 * Usage: node scripts/export-skill-seeds.mjs
 *
 * Home installs ship platform.* as core. Publish curated games.* (and optional extras)
 * to https://playon.games/skills/ — hosts install them on demand via catalog, not by hand.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(path.join(repoRoot, "apps/api/package.json"));
const { zipSync } = require("fflate");
const yaml = require("js-yaml");

const OUT = path.join(repoRoot, "dist", "skills");
const ROOTS = [
  path.join(repoRoot, "skills", "games"),
  path.join(repoRoot, "skills", "platform"),
];

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

fs.mkdirSync(OUT, { recursive: true });
const index = { updatedAt: new Date().toISOString(), skills: [] };

for (const root of ROOTS) {
  for (const skillDir of scan(root)) {
    const raw = yaml.load(fs.readFileSync(path.join(skillDir, "metadata.yaml"), "utf8"));
    const name = String(raw.name ?? "");
    const version = String(raw.version ?? "0.0.0");
    if (!name.startsWith("games.") && !name.startsWith("platform.")) continue;

    const files = walkFiles(skillDir);
    if (!files["metadata.yaml"]) throw new Error(`missing metadata in ${skillDir}`);
    const bytes = zipSync(files, { level: 6 });
    const filename = `${slugify(name)}-${version}.skill.zip`;
    fs.writeFileSync(path.join(OUT, filename), bytes);

    // sha256 via openssl/shasum when available
    let sha256 = "";
    try {
      sha256 = execFileSync(
        process.platform === "win32" ? "certutil" : "sha256sum",
        process.platform === "win32"
          ? ["-hashfile", path.join(OUT, filename), "SHA256"]
          : [path.join(OUT, filename)],
        { encoding: "utf8" },
      );
      if (process.platform === "win32") {
        sha256 = sha256.split(/\r?\n/).map((l) => l.trim()).find((l) => /^[0-9a-f]{64}$/i.test(l)) ?? "";
      } else {
        sha256 = sha256.trim().split(/\s+/)[0] ?? "";
      }
    } catch {
      sha256 = "";
    }

    index.skills.push({
      name,
      version,
      game: raw.game ?? null,
      description: raw.description ?? "",
      tags: raw.tags ?? [],
      dependencies: raw.dependencies ?? [],
      containerSupport: raw.containerSupport ?? "none",
      minRamMb: raw.minRamMb ?? null,
      steamAppId: raw.steamAppId ?? null,
      dockerImage: raw.dockerImage ?? null,
      downloadUrl: `./${filename}`,
      sha256: sha256.toLowerCase(),
      official: true,
    });
    console.log(`wrote ${filename}`);
  }
}

index.skills.sort((a, b) => a.name.localeCompare(b.name));
fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify(index, null, 2) + "\n");
console.log(`index: ${index.skills.length} skills → ${OUT}`);
