#!/usr/bin/env node
/**
 * Reclaim lab-matrix leftovers on playon-lab / durable Home.
 *
 * - Removes abandoned /tmp/playon-lab-matrix-* trees
 * - When no lab-matrix.mjs is running: stop+delete durable Home lab-matrix-* servers
 *   (never touches Minecraft / Zomboid / non-lab names)
 *
 * Usage:
 *   pnpm lab:matrix-cleanup
 *   pnpm lab:matrix-cleanup --dry-run
 *   pnpm lab:matrix-cleanup --max-age-hours 0   # wipe all unused temp roots
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HomeClient,
  loadHomeAuth,
  windowsPlacementConfig,
} from "./lab-matrix-home-client.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(repoRoot);

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
function flagValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  return argv[i + 1] ?? null;
}
const maxAgeHours = Number(flagValue("--max-age-hours") ?? "1");
const maxAgeMs = Number.isFinite(maxAgeHours) ? maxAgeHours * 3600_000 : 3600_000;

function matrixPids() {
  try {
    // Match the matrix runner only — not cleanup scripts / shells that merely
    // mention lab-matrix.mjs in their argv (scp/cp/pnpm wrappers).
    const out = execSync(
      "pgrep -af 'node .*scripts/lab-matrix\\.mjs' || true",
      { encoding: "utf8", shell: "/bin/bash" },
    );
    const pids = [];
    for (const line of out.split(/\n/)) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      const cmdline = m[2];
      if (cmdline.includes("lab-matrix-cleanup")) continue;
      if (!/node\s+.*lab-matrix\.mjs/.test(cmdline)) continue;
      pids.push(m[1]);
    }
    return pids;
  } catch {
    return [];
  }
}

function anyProcReferencesRoot(root) {
  const norm = path.resolve(root);
  try {
    const out = execSync("ps -eo pid=,args=", { encoding: "utf8" });
    for (const line of out.split(/\n/)) {
      if (line.includes(norm)) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function tempRootInUse(root, pids) {
  const norm = path.resolve(root);
  if (anyProcReferencesRoot(norm)) return true;
  for (const pid of pids) {
    try {
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      if (cwd === norm || cwd.startsWith(norm + path.sep) || norm.startsWith(cwd + path.sep)) {
        return true;
      }
    } catch {
      /* gone */
    }
    try {
      const fdDir = `/proc/${pid}/fd`;
      for (const fd of fs.readdirSync(fdDir)) {
        try {
          const target = fs.readlinkSync(path.join(fdDir, fd));
          if (target === norm || target.startsWith(norm + path.sep)) return true;
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }
  return false;
}

function sweepTempRoots({ pids, maxAgeMs: age }) {
  const tmp = os.tmpdir();
  let removed = 0;
  let bytes = 0;
  let kept = 0;
  for (const name of fs.readdirSync(tmp)) {
    if (!name.startsWith("playon-lab-matrix-")) continue;
    const full = path.join(tmp, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (tempRootInUse(full, pids)) {
      kept++;
      console.log(`keep in-use ${full}`);
      continue;
    }
    if (Date.now() - st.mtimeMs < age) {
      kept++;
      continue;
    }
    // rough size
    try {
      const du = execSync("du -sb -- " + full.replace(/(["\\$`])/g, "\\$1"), {
        encoding: "utf8",
      });
      bytes += Number(du.split(/\s+/)[0] || 0) || 0;
    } catch {
      /* ignore */
    }
    if (dryRun) {
      console.log(`dry-run: rm ${full}`);
      removed++;
      continue;
    }
    try {
      fs.rmSync(full, { recursive: true, force: true });
      console.log(`removed ${full}`);
      removed++;
    } catch (err) {
      // Docker/native installs often leave root-owned files under game/
      try {
        execSync(`chmod -R u+w -- ${full.replace(/(["\\$`])/g, "\\$1")} 2>/dev/null || true`, {
          shell: "/bin/bash",
        });
        fs.rmSync(full, { recursive: true, force: true });
        console.log(`removed ${full} (after chmod)`);
        removed++;
      } catch (err2) {
        console.warn(
          `failed ${full}: ${err2 instanceof Error ? err2.message : err2} (orig ${err instanceof Error ? err.message : err})`,
        );
      }
    }
  }
  return { removed, kept, gib: Math.round((bytes / 1024 ** 3) * 10) / 10 };
}

async function sweepHomeOrphans(pids) {
  if (pids.length) {
    console.log(`skip home orphans: ${pids.length} lab-matrix.mjs still running`);
    return { deleted: 0, skipped: true };
  }
  const cfg = windowsPlacementConfig(repoRoot);
  let auth;
  try {
    auth = await loadHomeAuth(cfg);
  } catch (err) {
    console.warn(`home auth unavailable: ${err instanceof Error ? err.message : err}`);
    return { deleted: 0, skipped: true };
  }
  const home = new HomeClient(auth);
  let list;
  try {
    list = await home.rest("/api/servers");
  } catch (err) {
    console.warn(`servers list failed: ${err instanceof Error ? err.message : err}`);
    return { deleted: 0, skipped: true };
  }
  const servers = Array.isArray(list)
    ? list
    : Array.isArray(list?.servers)
      ? list.servers
      : [];
  let deleted = 0;
  for (const s of servers) {
    const name = String(s?.name ?? "");
    if (!name.startsWith("lab-matrix-")) continue;
    const id = s.id;
    console.log(`orphan ${name} status=${s.status} id=${id}`);
    if (dryRun) {
      deleted++;
      continue;
    }
    try {
      if (["running", "starting", "stopping"].includes(s.status)) {
        await home.rest(`/api/servers/${id}/stop`, { method: "POST", body: {} });
      }
    } catch {
      /* ignore */
    }
    try {
      await home.rest(`/api/servers/${id}`, { method: "DELETE" });
      console.log(`deleted ${name}`);
      deleted++;
    } catch (err) {
      console.warn(`delete failed ${name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { deleted, skipped: false };
}

async function main() {
  const pids = matrixPids();
  console.log(`lab-matrix pids=${pids.join(",") || "none"} maxAgeHours=${maxAgeHours} dryRun=${dryRun}`);
  const temp = sweepTempRoots({ pids, maxAgeMs });
  console.log(`temp removed=${temp.removed} kept=${temp.kept} ~${temp.gib}GiB`);
  const home = await sweepHomeOrphans(pids);
  console.log(`home lab-matrix deleted=${home.deleted}${home.skipped ? " (skipped)" : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
