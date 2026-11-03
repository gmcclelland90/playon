/**
 * Locate or download the playon.games catalog the clone-isolation checks scan.
 * Packages are public .skill.zip files. Nothing here talks to a live game server.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { listPackages } from "./scan.mjs";

export const DEFAULT_CATALOG_URL = "https://playon.games/packages/index.json";

export function siblingGamesRoot(repoRoot) {
  const candidates = [
    process.env.PLAYON_GAMES_SKILLS_ROOT?.trim(),
    path.join(repoRoot, "..", "playon-games", "packages-src", "games"),
    path.join(repoRoot, "..", "playon-games", "skills-src", "games"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return path.resolve(candidate);
  }
  return null;
}

function readU16(buf, off) {
  return buf.readUInt16LE(off);
}
function readU32(buf, off) {
  return buf.readUInt32LE(off);
}

/** Extract a catalog .skill.zip. Refuses absolute paths and `..`. */
export function extractZip(buf, dest) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("zip: missing end of central directory");
  const count = readU16(buf, eocd + 10);
  let cursor = readU32(buf, eocd + 16);
  fs.mkdirSync(dest, { recursive: true });
  for (let i = 0; i < count; i++) {
    if (readU32(buf, cursor) !== 0x02014b50) throw new Error("zip: bad central directory");
    const method = readU16(buf, cursor + 10);
    const compSize = readU32(buf, cursor + 20);
    const nameLen = readU16(buf, cursor + 28);
    const extraLen = readU16(buf, cursor + 30);
    const commentLen = readU16(buf, cursor + 32);
    const localOff = readU32(buf, cursor + 42);
    const name = buf.slice(cursor + 46, cursor + 46 + nameLen).toString("utf8");
    cursor += 46 + nameLen + extraLen + commentLen;
    if (!name || name.endsWith("/")) continue;
    if (name.includes("..") || path.isAbsolute(name) || name.startsWith("/") || name.includes("\\")) {
      throw new Error(`zip: unsafe path ${name}`);
    }
    const localNameLen = readU16(buf, localOff + 26);
    const localExtraLen = readU16(buf, localOff + 28);
    const dataOff = localOff + 30 + localNameLen + localExtraLen;
    const compressed = buf.subarray(dataOff, dataOff + compSize);
    const data = method === 0 ? compressed : method === 8 ? zlib.inflateRawSync(compressed) : null;
    if (!data) throw new Error(`zip: unsupported method ${method} for ${name}`);
    const out = path.join(dest, name);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
  }
}

async function fetchBuffer(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "playon-clone-isolation", accept: "*/*" },
  });
  if (!response.ok) {
    throw new Error(`catalog download failed ${response.status} ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Download every games.* package into `dest/<name>/`. Reuses a directory that
 * already has metadata.yaml. Returns the package list.
 */
export async function downloadCatalog(dest, catalogUrl = DEFAULT_CATALOG_URL) {
  fs.mkdirSync(dest, { recursive: true });
  const index = JSON.parse((await fetchBuffer(catalogUrl)).toString("utf8"));
  const skills = Array.isArray(index.skills) ? index.skills : [];
  if (!skills.length) throw new Error(`catalog index has no skills: ${catalogUrl}`);
  for (const skill of skills) {
    const name = skill.name;
    const pkgDir = path.join(dest, name);
    const marker = path.join(pkgDir, "metadata.yaml");
    if (fs.existsSync(marker)) continue;
    if (!skill.downloadUrl) throw new Error(`catalog entry ${name} has no downloadUrl`);
    const zip = await fetchBuffer(skill.downloadUrl);
    fs.rmSync(pkgDir, { recursive: true, force: true });
    extractZip(zip, pkgDir);
    if (!fs.existsSync(marker)) {
      throw new Error(`catalog package ${name} did not contain metadata.yaml`);
    }
  }
  const packages = listPackages(dest);
  if (packages.length < skills.length) {
    const have = new Set(packages.map((pkg) => pkg.metadata.name));
    const missing = skills.map((skill) => skill.name).filter((name) => !have.has(name));
    throw new Error(`catalog extract missing ${missing.slice(0, 8).join(", ")}`);
  }
  return packages;
}
