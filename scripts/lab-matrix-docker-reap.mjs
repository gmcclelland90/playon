/**
 * Reap leftover lab-matrix Docker containers that still publish host ports.
 * Never touches non-playon names, playon-ollama, NZL-shaped names, or Home inventory.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { leftoverPlayonContainers } from "../packages/runtime/dist/leftover-port-holders.js";
import { listHostContainers } from "../packages/runtime/dist/docker-inventory.js";
import { playonContainerName } from "../packages/shared/dist/index.js";

export function dockerRmForce(name) {
  if (!name || typeof name !== "string") return false;
  try {
    execFileSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

export function serverIdsFromPlayonDb(dbPath, createDb) {
  if (!dbPath || !fs.existsSync(dbPath) || typeof createDb !== "function") return [];
  try {
    const { sqlite } = createDb(dbPath);
    try {
      return sqlite.prepare("select id from servers").all().map((r) => String(r.id));
    } finally {
      sqlite.close();
    }
  } catch {
    return [];
  }
}

export function listMatrixTempRoots({ tmp = os.tmpdir(), keepPath = null } = {}) {
  let entries = [];
  try {
    entries = fs.readdirSync(tmp);
  } catch {
    return [];
  }
  const keep = keepPath ? path.resolve(keepPath) : null;
  const roots = [];
  for (const name of entries) {
    if (!name.startsWith("playon-lab-matrix-")) continue;
    const full = path.join(tmp, name);
    if (keep && path.resolve(full) === keep) continue;
    try {
      if (fs.statSync(full).isDirectory()) roots.push(full);
    } catch {
      /* gone */
    }
  }
  return roots;
}

export function knownLeftoverNamesFromTempRoots({
  createDb,
  tmp,
  keepPath,
  inUse,
} = {}) {
  const names = new Set();
  for (const root of listMatrixTempRoots({ tmp, keepPath })) {
    if (typeof inUse === "function" && inUse(root)) continue;
    for (const id of serverIdsFromPlayonDb(path.join(root, "playon.db"), createDb)) {
      names.add(playonContainerName(id));
    }
  }
  return names;
}

/**
 * @param {object} opts
 * @param {Iterable<string>} [opts.homeProtectNames]
 * @param {boolean} opts.homeProtectLoaded
 * @param {Iterable<string>} [opts.knownLeftoverNames]
 * @param {Array<{ host: number, protocol: "tcp" | "udp" }>} [opts.ports]
 * @param {(c: { name: string }) => void} [opts.onReap]
 * @param {() => Promise<import("@playon/runtime").HostContainer[]>} [opts.list]
 * @param {(name: string) => boolean} [opts.rm]
 */
export async function reapLabMatrixDockerLeftovers({
  homeProtectNames = [],
  homeProtectLoaded,
  knownLeftoverNames = [],
  ports,
  onReap,
  list,
  rm = dockerRmForce,
} = {}) {
  const containers = list ? await list() : await listHostContainers({ timeoutMs: 4_000 });
  const targets = leftoverPlayonContainers(containers, {
    protectNames: homeProtectNames,
    protectListLoaded: Boolean(homeProtectLoaded),
    knownLeftoverNames,
    ports,
  });
  let removed = 0;
  for (const c of targets) {
    if (rm(c.name)) {
      removed += 1;
      onReap?.(c);
    }
  }
  return { considered: containers.length, removed, names: targets.map((c) => c.name) };
}
