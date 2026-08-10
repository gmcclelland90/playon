#!/usr/bin/env node
/**
 * Catalog-wide lab stress matrix (playon-dev Local + Windows worker).
 *
 * Linux/Docker/Steam-Linux skills: create → install → start → open/query → stop
 * under an isolated temp data root (never durable Home inventory / playon-node-1).
 *
 * Windows-only / PE skills: place on playon-win-1 via live Home API/MCP (the
 * Windows agent only jobs against durable Home). Disposable lab-matrix-* names.
 *
 * Usage:
 *   pnpm lab:matrix
 *   pnpm lab:matrix --tier static
 *   pnpm lab:matrix --skill games.minecraft-paper
 *   pnpm lab:matrix --filter windows
 *   pnpm lab:matrix --resume
 *   pnpm lab:matrix --from games.valheim
 *
 * Status: tmp/lab-matrix-status.json
 * Issues: tmp/lab-matrix-issues.jsonl
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../apps/api/dist/db/client.js";
import { applyBootstrap } from "../apps/api/dist/db/migrate.js";
import { createControlPlane } from "../apps/api/dist/control-plane.js";
import { listSkills, loadSkillMetadata } from "../apps/api/dist/services/skills.js";
import { steamcmdAppUpdate } from "../apps/api/dist/services/steamcmd.js";
import { execConsoleCommand } from "../apps/api/dist/services/server-console.js";
import { createRuntimeAdapters } from "../packages/runtime/dist/factory.js";
import { LOCAL_NODE_ID } from "../packages/shared/dist/index.js";
import {
  HomeClient,
  loadHomeAuth,
  wantsWindowsPlacement,
  windowsPlacementConfig,
} from "./lab-matrix-home-client.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(repoRoot);

const STATUS_PATH = process.env.PLAYON_LAB_MATRIX_STATUS
  ? path.resolve(process.env.PLAYON_LAB_MATRIX_STATUS)
  : path.join(repoRoot, "tmp", "lab-matrix-status.json");
const ISSUES_PATH = process.env.PLAYON_LAB_MATRIX_ISSUES
  ? path.resolve(process.env.PLAYON_LAB_MATRIX_ISSUES)
  : path.join(repoRoot, "tmp", "lab-matrix-issues.jsonl");
const DURABLE_HOME_MARKERS = [
  path.normalize("/home/playon/src/playon/apps/api/data"),
  path.normalize("C:\\playon\\data"),
];

/** Skills that need operator-provided game files (no steam/docker/fetch automation). */
const HOST_SUPPLIED_SKILLS = new Set([
  "games.unreal-tournament-99",
  "games.quakeworld",
]);

/**
 * SteamCMD installs the dedi, but SCS convoy requires client-exported
 * server_packages.sii/.dat (export_server_packages) before the process stays up.
 */
const HOST_SUPPLIED_PACKAGES_SKILLS = new Set(["games.ats", "games.ets2"]);

const TOOLS_ARCHETYPES = [
  "games.minecraft-paper",
  "games.factorio",
  "games.openttd",
  "games.terraria",
  "games.cs2",
  "games.et-legacy",
  "games.assaultcube",
  "games.teeworlds",
  "games.valheim",
  "games.rust",
  "games.tf2",
  "games.project-zomboid",
  "games.scpsl",
  "games.minecraft-bedrock",
  "games.xonotic",
];

/**
 * Source/GoldSrc A2S often ignores loopback even when bound to 0.0.0.0 — queries
 * must hit a real NIC address (lab LAN). Override with PLAYON_ADVERTISE_HOST.
 */
function matrixAdvertiseHost() {
  const env = (process.env.PLAYON_ADVERTISE_HOST || process.env.PLAYON_MATRIX_ADVERTISE_HOST || "")
    .trim();
  if (env) return env;
  const ifaces = os.networkInterfaces();
  for (const entries of Object.values(ifaces)) {
    for (const e of entries ?? []) {
      if (e.family !== "IPv4" || e.internal) continue;
      if (e.address) return e.address;
    }
  }
  return "127.0.0.1";
}

const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  return argv[i + 1] ?? null;
}
function hasFlag(name) {
  return argv.includes(name);
}

const tier = flagValue("--tier") ?? "all";
const onlySkill = flagValue("--skill");
const fromSkill = flagValue("--from");
const filter = flagValue("--filter"); // docker | steam | native | other
const resume = hasFlag("--resume");
const continueOnFail = hasFlag("--continue-on-fail");
const source = flagValue("--source") ?? "sibling";
const concurrency = Math.max(1, Number(flagValue("--concurrency") ?? "1") || 1);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureDist() {
  const needed = [
    "apps/api/dist/control-plane.js",
    "apps/api/dist/services/servers.js",
    "packages/runtime/dist/factory.js",
    "packages/shared/dist/index.js",
  ];
  for (const rel of needed) {
    if (!fs.existsSync(path.join(repoRoot, rel))) {
      console.error(`missing ${rel} — run: pnpm build`);
      process.exit(2);
    }
  }
}

function resolveGamesRoot() {
  const fromEnv = process.env.PLAYON_GAMES_SKILLS_ROOT?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) return path.resolve(fromEnv);
  const sibling = path.join(repoRoot, "..", "playon-games", "skills-src", "games");
  if (fs.existsSync(sibling)) return sibling;
  return null;
}

function assertSafeDataRoot(dataRoot) {
  const norm = path.normalize(dataRoot);
  for (const marker of DURABLE_HOME_MARKERS) {
    if (norm === marker || norm.startsWith(marker + path.sep)) {
      throw new Error(`refusing durable Home data root: ${dataRoot}`);
    }
  }
  const envRoot = process.env.PLAYON_DATA_ROOT?.trim();
  if (envRoot) {
    const envNorm = path.normalize(path.resolve(envRoot));
    if (norm === envNorm || norm.startsWith(envNorm + path.sep)) {
      // Only refuse if env points at durable markers; temp custom roots are fine.
      for (const marker of DURABLE_HOME_MARKERS) {
        if (envNorm === marker || envNorm.startsWith(marker + path.sep)) {
          throw new Error(`PLAYON_DATA_ROOT points at durable Home: ${envRoot}`);
        }
      }
    }
  }
}

function loadStatus() {
  if (!fs.existsSync(STATUS_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(STATUS_PATH, "utf8"));
  } catch {
    return null;
  }
}

function writeStatus(status) {
  fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true });
  fs.writeFileSync(STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  // Throttled publish to sticky GitHub Lab status issue (primary cockpit).
  if ((process.env.PLAYON_LAB_PUBLISH_STATUS ?? "1") !== "0") {
    try {
      execSync(`${process.execPath} scripts/lab-publish-status.mjs`, {
        cwd: repoRoot,
        stdio: "ignore",
        env: process.env,
      });
    } catch {
      /* non-fatal */
    }
  }
}

function appendIssue(issue) {
  fs.mkdirSync(path.dirname(ISSUES_PATH), { recursive: true });
  fs.appendFileSync(ISSUES_PATH, `${JSON.stringify({ at: new Date().toISOString(), ...issue })}\n`);
}

/** True if a live lab-matrix.mjs process has cwd/fds under this temp root. */
function tempRootInUse(root) {
  const norm = path.resolve(root);
  let pids = [];
  try {
    const out = execSync("pgrep -af 'node .*scripts/lab-matrix\\.mjs' || true", {
      encoding: "utf8",
      shell: "/bin/bash",
    });
    pids = [];
    for (const line of out.split(/\n/)) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      if (m[1] === String(process.pid)) continue;
      if (!/node\s+.*lab-matrix\.mjs/.test(m[2])) continue;
      if (m[2].includes("lab-matrix-cleanup")) continue;
      pids.push(m[1]);
    }
  } catch {
    return false;
  }
  for (const pid of pids) {
    try {
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      if (cwd === norm || cwd.startsWith(`${norm}/`) || norm.startsWith(`${cwd}/`)) {
        return true;
      }
    } catch {
      /* ignore */
    }
    try {
      for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
        try {
          const target = fs.readlinkSync(path.join(`/proc/${pid}/fd`, fd));
          if (target === norm || target.startsWith(`${norm}/`)) return true;
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

/**
 * Remove abandoned /tmp/playon-lab-matrix-* trees left by killed matrix runs.
 * Keeps roots younger than maxAgeMs and any still referenced by a live process.
 */
function sweepStaleMatrixTempRoots({ keepPath = null, maxAgeMs = 3600_000 } = {}) {
  const tmp = os.tmpdir();
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(tmp);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!name.startsWith("playon-lab-matrix-")) continue;
    const full = path.join(tmp, name);
    if (keepPath && path.resolve(full) === path.resolve(keepPath)) continue;
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (Date.now() - st.mtimeMs < maxAgeMs) continue;
    if (tempRootInUse(full)) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true });
      removed += 1;
      console.log(`lab-matrix swept stale temp ${full}`);
    } catch (err) {
      console.warn(
        `lab-matrix sweep failed ${full}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return removed;
}

function removeDataRoot(dataRoot) {
  try {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  } catch {
    console.warn(`temp dataRoot left at ${dataRoot}`);
  }
}

function phaseMap() {
  return {
    static: null,
    install: null,
    create: null,
    start: null,
    port_open: null,
    health: null,
    query: null,
    admin: null,
    panel: null,
    snapshot: null,
    tools: null,
    stop: null,
    cleanup: null,
  };
}

function skillSlug(skillName) {
  return skillName.replace(/^games\./, "");
}

function gamePorts(meta) {
  // Primary join ports: game / query (+ common aliases like game-tcp).
  return (meta.ports ?? []).filter(
    (p) => p.default && /^(game|query)([-_]|$)/i.test(p.name),
  );
}

function tcpPorts(meta) {
  return gamePorts(meta).filter((p) => (p.protocol ?? "tcp") === "tcp");
}

function udpOnlyGame(meta) {
  const ports = gamePorts(meta);
  if (!ports.length) return false;
  return ports.every((p) => p.protocol === "udp");
}

/** Disposable Home name — unique per attempt so parallel cleanups cannot target "the" slug. */
function labMatrixServerName(skillName) {
  return `lab-matrix-${skillSlug(skillName)}-${Date.now().toString(36)}`;
}

/**
 * Resolve Home server status via MCP list (same bearer as tools).
 * Concurrent `cleanup-lab-matrix-servers` deletes cause REST 404 mid-lifecycle;
 * surface that as server_missing_mid_lifecycle instead of opaque home_rest_404.
 */
async function homeServerStatus(home, serverId) {
  const rows = await home.tool("servers_list", {});
  // MCP structuredContent is usually `{ result: ServerSummary[] }`, not a bare array.
  const list = Array.isArray(rows)
    ? rows
    : Array.isArray(rows?.result)
      ? rows.result
      : Array.isArray(rows?.servers)
        ? rows.servers
        : [];
  const hit = list.find((s) => s && s.id === serverId);
  if (hit) return hit.status ?? null;
  // Confirm via REST for a precise not_found signal.
  try {
    const detail = await home.rest(`/api/servers/${serverId}`);
    return detail?.server?.status ?? detail?.status ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/home_rest_404|server_not_found/i.test(msg)) {
      throw new Error(
        `server_missing_mid_lifecycle: ${serverId} (deleted while matrix owned it — avoid sweeping lab-matrix-* mid-run)`,
      );
    }
    throw err;
  }
}

/** Push skill `files/` into remote game/ via MCP (node-authoritative Steam installs skip Home push). */
async function pushSkillFilesViaHome(home, serverId, skillPath) {
  const overlayRoot = path.join(skillPath, "files");
  if (!fs.existsSync(overlayRoot) || !fs.statSync(overlayRoot).isDirectory()) {
    return [];
  }
  const written = [];
  const walk = async (srcDir, rel = "") => {
    for (const name of fs.readdirSync(srcDir)) {
      const src = path.join(srcDir, name);
      const destRel = rel ? `${rel}/${name}` : name;
      const st = fs.statSync(src);
      if (st.isDirectory()) {
        await walk(src, destRel);
        continue;
      }
      // Skip binaries / huge blobs in skill files — text overlays only.
      if (st.size > 512_000) continue;
      const content = fs.readFileSync(src, "utf8");
      const gamePath = `game/${destRel.replace(/\\/g, "/")}`;
      try {
        await home.tool("fs_write", { serverId, path: gamePath, content });
        written.push(gamePath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Ignore already-exists style conflicts; surface real failures.
        if (!/exists|EEXIST/i.test(msg)) throw err;
      }
    }
  };
  await walk(overlayRoot);
  return written;
}

/**
 * Retry overlay push — Windows nodes often stall fs_* for ~60s right after a
 * large SteamCMD commit (lab KF2: missing start.bat → udp_process_not_running).
 */
async function pushSkillFilesViaHomeWithRetry(home, serverId, skillPath, opts = {}) {
  const attempts = opts.attempts ?? 4;
  const delayMs = opts.delayMs ?? 15_000;
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await pushSkillFilesViaHome(home, serverId, skillPath);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!/timeout|ECONN|ENOTFOUND|job_failed/i.test(msg) || i === attempts - 1) {
        throw err;
      }
      await sleep(delayMs);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function skillOverlayHasStartBat(skillPath) {
  const bat = path.join(skillPath, "files", "start.bat");
  return fs.existsSync(bat) && fs.statSync(bat).isFile();
}

/** Copy skill `files/` into a local matrix game/ jail (skip existing). */
function copySkillFilesLocal(skillPath, gameDir) {
  const overlayRoot = path.join(skillPath, "files");
  if (!fs.existsSync(overlayRoot) || !fs.statSync(overlayRoot).isDirectory()) {
    return [];
  }
  const written = [];
  const walk = (srcDir, rel = "") => {
    for (const name of fs.readdirSync(srcDir)) {
      const src = path.join(srcDir, name);
      const destRel = rel ? `${rel}/${name}` : name;
      const st = fs.statSync(src);
      if (st.isDirectory()) {
        walk(src, destRel);
        continue;
      }
      const dest = path.join(gameDir, ...destRel.split("/"));
      if (fs.existsSync(dest)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      written.push(destRel.replace(/\\/g, "/"));
    }
  };
  walk(overlayRoot);
  return written;
}

async function waitForTcpOpen(net, host, port, { attempts = 30, delayMs = 2000 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    last = await net.portCheck({ host, port });
    if (last.state === "open") return last;
    await sleep(delayMs);
  }
  return last;
}

/** Linux UDP listen probe (TCP connect cannot prove UDP bind). */
function udpPortListening(port) {
  if (process.platform === "win32") return null;
  try {
    const out = execSync("ss -uln", { encoding: "utf8" });
    const re = new RegExp(`:${port}(\\s|$)`);
    return out.split(/\r?\n/).some((line) => re.test(line));
  } catch {
    return null;
  }
}

async function waitForUdpListening(port, { attempts = 40, delayMs = 3000 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    last = udpPortListening(port);
    if (last === true) return true;
    if (last === null) return null; // probe unavailable
    await sleep(delayMs);
  }
  return false;
}

async function waitForQuery(queries, serverId, { attempts = 20, delayMs = 3000 } = {}) {
  return queries.queryServerWithRetry(serverId, { attempts, delayMs });
}

function dockerCleanup(serverId) {
  const name = `playon-${serverId}`;
  try {
    execSync(`docker rm -f ${name}`, { stdio: "ignore" });
  } catch {
    /* ignore */
  }
}

async function runStatic(skill, skillsRoots) {
  const meta = skill.metadata;
  const loaded = loadSkillMetadata(skillsRoots, meta.name);
  if (!loaded) throw new Error(`skill_load_failed: ${meta.name}`);
  if (!meta.version) throw new Error("missing_version");
  if (!Array.isArray(meta.ports)) throw new Error("missing_ports");
  if (!meta.adminDialect) throw new Error("missing_adminDialect");
  if (!meta.queryDialect) throw new Error("missing_queryDialect");
  const guide = path.join(skill.path, "guides", "INSTALL.md");
  if (!fs.existsSync(guide)) throw new Error("missing_INSTALL.md");
  return { ok: true };
}

async function runWindowsLifecycle(skill, { home, winNodeId, winHost }) {
  const meta = skill.metadata;
  const phases = phaseMap();
  const startedAt = Date.now();
  let serverId = null;
  const notes = { placement: "windows", nodeId: winNodeId, winHost };

  try {
    phases.static = "ok";
    await home.requireWinNodeOnline(winNodeId);

    const serverName = labMatrixServerName(meta.name);
    notes.serverName = serverName;
    const created = await home.tool("servers_create_from_skill", {
      skillName: meta.name,
      serverName,
      nodeId: winNodeId,
    });
    serverId = created.serverId;
    if (!serverId) throw new Error("create_missing_serverId");
    notes.serverId = serverId;
    notes.runtimeMode = created.runtimeMode;
    phases.create = "ok";

    // Push overlays BEFORE SteamCMD. Large depots saturate Windows disk I/O so
    // post-install fs_write_text often hits the 60s job timeout; missing
    // start.bat then makes supervised cmd.exe exit (udp_process_not_running).
    try {
      const overlay = await pushSkillFilesViaHomeWithRetry(home, serverId, skill.path, {
        attempts: 3,
        delayMs: 10_000,
      });
      if (overlay.length) notes.skillOverlay = overlay;
    } catch (err) {
      notes.skillOverlay = {
        error: err instanceof Error ? err.message : String(err),
        phase: "pre_install",
      };
    }

    if (typeof meta.steamAppId === "number") {
      try {
        const install = await home.tool("steamcmd_app_update", {
          serverId,
          appId: meta.steamAppId,
          ...(typeof meta.steamMod === "string" ? { steamMod: meta.steamMod } : {}),
          ...(typeof meta.steamBetaLinux === "string"
            ? { steamBetaLinux: meta.steamBetaLinux }
            : {}),
        });
        notes.install = {
          exitCode: install.exitCode,
          stdoutTail: typeof install.stdoutTail === "string" ? install.stdoutTail.slice(-400) : undefined,
        };
        phases.install = "ok";
        // SteamCMD can exit 0 while publishing EmptySteamDepot + SizeOnDisk=0
        // (e.g. Risk of Rain 2 dedicated 1180760 public build 20243729).
        try {
          const listing = await home.tool("fs_list", { serverId, path: "game" });
          const entries = listing.result || listing.entries || [];
          const names = (Array.isArray(entries) ? entries : []).map((e) => e.name);
          if (names.includes("EmptySteamDepot")) {
            let sizeOnDisk = null;
            try {
              const acf = await home.tool("fs_read", {
                serverId,
                path: `game/steamapps/appmanifest_${meta.steamAppId}.acf`,
                maxBytes: 4000,
              });
              const text = acf.content || acf.text || "";
              const m = /"SizeOnDisk"\s+"(\d+)"/.exec(text);
              sizeOnDisk = m ? Number(m[1]) : null;
            } catch {
              /* ignore */
            }
            if (sizeOnDisk === 0 || sizeOnDisk === null) {
              const msg = `steamcmd_empty_depot: appId=${meta.steamAppId} EmptySteamDepot SizeOnDisk=${sizeOnDisk ?? "unknown"}`;
              notes.install.emptyDepot = true;
              await safeHomeCleanup(home, serverId);
              return {
                skillName: meta.name,
                ok: true,
                skipped: true,
                skipReason: "steamcmd_empty_depot",
                phases: { ...phases, install: "skipped", cleanup: "ok" },
                durationMs: Date.now() - startedAt,
                notes,
                tail: msg,
              };
            }
          }
        } catch (probeErr) {
          notes.install.emptyDepotProbe = String(
            probeErr instanceof Error ? probeErr.message : probeErr,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Exit 8 / No subscription: paid depot under anonymous SteamCMD.
        // Also seen when the Windows node is out of disk (orphan lab installs).
        if (/steamcmd_no_subscription|No subscription|exit=8\b/i.test(msg)) {
          await safeHomeCleanup(home, serverId);
          return {
            skillName: meta.name,
            ok: true,
            skipped: true,
            skipReason: "steamcmd_no_subscription",
            phases: { ...phases, install: "skipped", cleanup: "ok" },
            durationMs: Date.now() - startedAt,
            notes,
            tail: msg,
          };
        }
        if (/steamcmd_empty_depot/i.test(msg)) {
          await safeHomeCleanup(home, serverId);
          return {
            skillName: meta.name,
            ok: true,
            skipped: true,
            skipReason: "steamcmd_empty_depot",
            phases: { ...phases, install: "skipped", cleanup: "ok" },
            durationMs: Date.now() - startedAt,
            notes,
            tail: msg,
          };
        }
        throw err;
      }
    } else {
      phases.install = "skipped";
    }

    // Re-push after install (SteamCMD validate can clobber root bats) + cool-down.
    try {
      await sleep(5_000);
      const overlay = await pushSkillFilesViaHomeWithRetry(home, serverId, skill.path, {
        attempts: 4,
        delayMs: 20_000,
      });
      notes.skillOverlay = overlay.length
        ? overlay
        : notes.skillOverlay ?? overlay;
    } catch (err) {
      notes.skillOverlay = {
        ...(typeof notes.skillOverlay === "object" && notes.skillOverlay
          ? notes.skillOverlay
          : {}),
        error: err instanceof Error ? err.message : String(err),
        phase: "post_install",
      };
    }

    if (skillOverlayHasStartBat(skill.path)) {
      const overlayOk = Array.isArray(notes.skillOverlay)
        ? notes.skillOverlay.some((p) => String(p).endsWith("start.bat"))
        : false;
      if (!overlayOk) {
        // Verify on node — may already exist from a partial write.
        let present = false;
        try {
          await home.tool("fs_read", {
            serverId,
            path: "game/start.bat",
            maxBytes: 200,
          });
          present = true;
        } catch {
          present = false;
        }
        if (!present) {
          throw new Error(
            `skill_overlay_missing: game/start.bat (${JSON.stringify(notes.skillOverlay)})`,
          );
        }
      }
    }

    const started = await home.tool("servers_start", { serverId });
    phases.start =
      started.status === "running" || started.status === "starting" ? "ok" : "fail";
    if (phases.start !== "ok") throw new Error(`start_status_${started.status}`);

    const slowFirst = Array.isArray(meta.tags) && meta.tags.includes("slow_first_boot");
    await sleep(slowFirst ? 30_000 : 12_000);

    const tcp = tcpPorts(meta);
    const tcpWait = { attempts: slowFirst ? 120 : 40, delayMs: 3000 };
    const queryWait = { attempts: slowFirst ? 80 : 30, delayMs: 3000 };

    if (tcp.length) {
      const opens = [];
      for (const p of tcp) {
        let last = null;
        for (let i = 0; i < tcpWait.attempts; i++) {
          last = await home.tool("net_port_check", { host: winHost, port: p.default });
          if (last.state === "open") break;
          await sleep(tcpWait.delayMs);
        }
        opens.push({ name: p.name, port: p.default, state: last?.state, host: winHost });
        if (last?.state !== "open") {
          throw new Error(`port_not_open: ${p.name}:${p.default}@${winHost} state=${last?.state}`);
        }
      }
      notes.ports = opens;
      phases.port_open = "ok";
    } else if (udpOnlyGame(meta) || meta.queryDialect !== "none") {
      // Remote UDP listen isn't visible via Home ss; require running + query when dialect set.
      let running = false;
      for (let i = 0; i < 40; i++) {
        const status = await homeServerStatus(home, serverId);
        running = status === "running";
        if (running) break;
        await sleep(3000);
      }
      if (!running) throw new Error("udp_process_not_running");
      phases.port_open = "ok";
    } else {
      const status = await homeServerStatus(home, serverId);
      if (status !== "running") throw new Error("running_without_ports_failed");
      phases.port_open = "ok";
    }

    try {
      const health = await home.tool("servers_health_check", { serverId });
      notes.health = { ok: Boolean(health.ok), checks: health.checks };
      phases.health = notes.health.ok ? "ok" : "soft";
    } catch (err) {
      notes.health = { error: err instanceof Error ? err.message : String(err) };
      phases.health = "soft";
    }

    if (meta.queryDialect !== "none") {
      let q = null;
      for (let i = 0; i < queryWait.attempts; i++) {
        q = await home.tool("servers_query", { serverId });
        if (q.online) break;
        await sleep(queryWait.delayMs);
      }
      notes.query = { online: q?.online, error: q?.error, name: q?.name };
      if (!q?.online) throw new Error(`query_offline: ${q?.error ?? "unknown"}`);
      phases.query = "ok";
    } else {
      phases.query = "skipped";
    }

    phases.admin = "skipped";
    await home.tool("servers_stop", { serverId });
    phases.stop = "ok";
    await home.tool("servers_delete", { serverId });
    phases.cleanup = "ok";
    serverId = null;

    const hardFail = ["create", "start", "port_open", "stop", "cleanup"].some(
      (k) => phases[k] === "fail" || phases[k] === null,
    );
    const queryFail = meta.queryDialect !== "none" && phases.query !== "ok";
    return {
      skillName: meta.name,
      ok: !hardFail && !queryFail,
      skipped: false,
      serverId: notes.serverId,
      phases,
      notes,
      durationMs: Date.now() - startedAt,
      tail: queryFail ? notes.query?.error ?? "query_failed" : null,
    };
  } catch (err) {
    const tail = err instanceof Error ? err.message : String(err);
    if (serverId) {
      await safeHomeCleanup(home, serverId);
      phases.cleanup = phases.cleanup ?? "ok";
    }
    for (const key of Object.keys(phases)) {
      if (phases[key] === null) {
        phases[key] = "fail";
        break;
      }
    }
    return {
      skillName: meta.name,
      ok: false,
      skipped: false,
      serverId: notes.serverId ?? serverId,
      phases,
      notes,
      durationMs: Date.now() - startedAt,
      tail,
    };
  }
}

async function safeHomeCleanup(home, serverId) {
  try {
    await home.tool("servers_stop", { serverId });
  } catch {
    /* ignore */
  }
  try {
    await home.tool("servers_delete", { serverId });
  } catch {
    /* ignore */
  }
}

async function runLifecycle(cp, skill, { runTools, windows }) {
  const { servers, net, queries, health, snapshots, panel } = cp;
  const meta = skill.metadata;
  const phases = phaseMap();
  const startedAt = Date.now();
  let serverId = null;
  const notes = {};

  if (HOST_SUPPLIED_SKILLS.has(meta.name)) {
    return {
      skillName: meta.name,
      ok: true,
      skipped: true,
      skipReason: "host_supplied_binaries",
      phases,
      durationMs: 0,
    };
  }

  if (HOST_SUPPLIED_PACKAGES_SKILLS.has(meta.name)) {
    return {
      skillName: meta.name,
      ok: true,
      skipped: true,
      skipReason: "host_supplied_packages",
      phases: { ...phases, static: "ok" },
      durationMs: 0,
      tail: "needs client export_server_packages (server_packages.sii/.dat)",
    };
  }

  // Windows-only / PE titles → live Home + playon-win-1 (not in-process Local).
  if (windows?.enabled && wantsWindowsPlacement(meta)) {
    return runWindowsLifecycle(skill, windows);
  }

  // Skill declares supported host OS; skip when lab host is outside that set
  // (e.g. Windows-only PE with Windows dual-place disabled).
  const hostOs = process.platform === "win32" ? "windows" : "linux";
  if (Array.isArray(meta.os) && meta.os.length > 0 && !meta.os.includes(hostOs)) {
    return {
      skillName: meta.name,
      ok: true,
      skipped: true,
      skipReason: "unsupported_host_os",
      phases: { ...phases, static: "ok" },
      durationMs: 0,
      tail: `skill os=${meta.os.join(",")} host=${hostOs}`,
    };
  }

  // Primary native binary is a Windows PE; PlayOn has no Wine/Proton runtime.
  const primaryBinary = String(meta.native?.binary ?? "").replace(/\\/g, "/");
  if (hostOs === "linux" && /\.exe$/i.test(primaryBinary)) {
    return {
      skillName: meta.name,
      ok: true,
      skipped: true,
      skipReason: "windows_only_pe",
      phases: { ...phases, static: "ok" },
      durationMs: 0,
      tail: `native.binary=${primaryBinary}`,
    };
  }

  // FOSS/other without steam/docker: attempt create+start; if binaries missing → allowed skip.
  const automatable =
    typeof meta.steamAppId === "number" ||
    (meta.containerSupport === "full" && !!meta.dockerImage);

  try {
    phases.static = "ok";

    const created = await servers.createFromSkill({
      skillName: meta.name,
      serverName: `lab-matrix-${skillSlug(meta.name)}`,
      nodeId: LOCAL_NODE_ID,
    });
    serverId = created.id;
    if (created.nodeId && created.nodeId !== LOCAL_NODE_ID) {
      throw new Error(`remote_placement_forbidden: nodeId=${created.nodeId}`);
    }
    phases.create = "ok";
    notes.serverId = serverId;
    notes.runtimeMode = created.runtimeMode;

    if (typeof meta.steamAppId === "number") {
      try {
        await steamcmdAppUpdate({
          serverDataPath: created.dataPath,
          appId: meta.steamAppId,
          steamMod: typeof meta.steamMod === "string" ? meta.steamMod : undefined,
          steamBetaLinux:
            typeof meta.steamBetaLinux === "string" ? meta.steamBetaLinux : undefined,
          autoInstall: true,
          timeoutMs: 1_800_000,
        });
        phases.install = "ok";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/steamcmd_invalid_platform|Invalid platform/i.test(msg)) {
          await safeCleanup(servers, serverId);
          serverId = null;
          // Depot is Windows-only — place on playon-win-1 when that worker is online.
          if (windows?.enabled) {
            console.log(
              `lab-matrix ${meta.name}: linux steamcmd invalid platform → windows dual-place`,
            );
            return runWindowsLifecycle(skill, windows);
          }
          return {
            skillName: meta.name,
            ok: true,
            skipped: true,
            skipReason: "windows_only_depot",
            phases: { ...phases, install: "skipped", cleanup: "ok" },
            durationMs: Date.now() - startedAt,
            tail: msg,
          };
        }
        // Anonymous SteamCMD: paid/licensed depot with no subscription (exit 8 typical).
        if (/steamcmd_no_subscription|No subscription/i.test(msg)) {
          await safeCleanup(servers, serverId);
          return {
            skillName: meta.name,
            ok: true,
            skipped: true,
            skipReason: "steamcmd_no_subscription",
            phases: { ...phases, install: "skipped", cleanup: "ok" },
            durationMs: Date.now() - startedAt,
            tail: msg,
          };
        }
        throw err;
      }
    } else if (meta.dockerImage) {
      phases.install = "ok"; // image pull happens on start
    } else {
      phases.install = "skipped";
    }

    try {
      const gameDir = path.join(created.dataPath, "game");
      const copiedSkillOverlay = copySkillFilesLocal(skill.path, gameDir);
      if (copiedSkillOverlay.length) notes.skillOverlay = copiedSkillOverlay;
      const started = await servers.start(serverId);
      phases.start = started.status === "running" || started.status === "starting" ? "ok" : "fail";
      if (phases.start !== "ok") throw new Error(`start_status_${started.status}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!automatable && /native_binaries_missing/.test(msg)) {
        await safeCleanup(servers, serverId);
        return {
          skillName: meta.name,
          ok: true,
          skipped: true,
          skipReason: "no_automated_install",
          phases: { ...phases, start: "skipped", cleanup: "ok" },
          durationMs: Date.now() - startedAt,
          tail: msg,
        };
      }
      // Attach console log tail for native start failures
      try {
        const logPath = path.join(created.dataPath, "logs", "console.log");
        if (fs.existsSync(logPath)) {
          const logTail = fs.readFileSync(logPath, "utf8").slice(-800);
          notes.consoleTail = logTail;
        }
      } catch {
        /* ignore */
      }
      throw err;
    }

    // Settle after start (Docker images / heavy native first boots need longer)
    const slowFirst = Array.isArray(meta.tags) && meta.tags.includes("slow_first_boot");
    const settleMs = meta.dockerImage
      ? slowFirst
        ? 60_000
        : 20_000
      : slowFirst
        ? 30_000
        : 8_000;
    await sleep(settleMs);

    const tcp = tcpPorts(meta);
    // slow_first_boot (e.g. CS2 Steam depot / Arma Reforger scenario): long TCP/UDP/query polling.
    const tcpWait = meta.dockerImage
      ? { attempts: slowFirst ? 800 : 60, delayMs: 3000 }
      : { attempts: slowFirst ? 120 : 30, delayMs: 2000 };
    const queryWait = meta.dockerImage
      ? { attempts: slowFirst ? 800 : 40, delayMs: 3000 }
      : { attempts: slowFirst ? 80 : 20, delayMs: 3000 };

    if (tcp.length) {
      const opens = [];
      for (const p of tcp) {
        const probe = await waitForTcpOpen(net, "127.0.0.1", p.default, tcpWait);
        opens.push({ name: p.name, port: p.default, state: probe?.state });
        if (probe?.state !== "open") {
          throw new Error(`port_not_open: ${p.name}:${p.default} state=${probe?.state}`);
        }
      }
      notes.ports = opens;
      phases.port_open = "ok";
    } else if (udpOnlyGame(meta)) {
      // UDP cannot use TCP connect; prove listen via ss, then query when available.
      let running = false;
      for (let i = 0; i < 40; i++) {
        running = (await servers.get(serverId))?.status === "running";
        if (running) break;
        await sleep(3000);
      }
      if (!running) throw new Error("udp_process_not_running");
      const udpGame = gamePorts(meta).filter((p) => p.protocol === "udp");
      // When a query dialect is declared, hard-require the queryPortName listen
      // only. Games like Avorion (Steam networking) advertise a UDP game port
      // that never shows in `ss -uln`, while A2S answers on steam-query.
      const queryName = typeof meta.queryPortName === "string" ? meta.queryPortName.trim() : "";
      const requireQueryOnly =
        !!queryName && meta.queryDialect && meta.queryDialect !== "none";
      const mustListen = requireQueryOnly
        ? udpGame.filter((p) => p.name === queryName)
        : udpGame;
      const listenTargets = mustListen.length ? mustListen : udpGame;
      const udpProbes = [];
      for (const p of udpGame) {
        const listening = await waitForUdpListening(p.default, tcpWait);
        const required = listenTargets.some((t) => t.name === p.name && t.default === p.default);
        udpProbes.push({ name: p.name, port: p.default, listening, required });
        if (required && listening === false) {
          throw new Error(`udp_port_not_listening: ${p.name}:${p.default}`);
        }
      }
      notes.ports = udpProbes;
      phases.port_open = "ok";
      const report = await health.checkServer(serverId);
      notes.health = { ok: report.ok, checks: report.checks };
      phases.health = report.ok ? "ok" : "soft";
      if (meta.queryDialect !== "none") {
        const q = await waitForQuery(queries, serverId, queryWait);
        notes.query = { online: q.online, error: q.error };
        if (!q.online) throw new Error(`query_offline: ${q.error ?? "unknown"}`);
        phases.query = "ok";
      }
    } else {
      // No declared game ports — require running + health
      const report = await health.checkServer(serverId);
      notes.health = { ok: report.ok, checks: report.checks };
      if ((await servers.get(serverId))?.status !== "running") {
        throw new Error("running_without_ports_failed");
      }
      phases.port_open = "ok";
      phases.health = report.ok ? "ok" : "soft";
    }

    if (phases.health === null) {
      const report = await health.checkServer(serverId);
      notes.health = { ok: report.ok, checks: report.checks };
      phases.health = report.ok ? "ok" : "soft";
    }

    if (meta.queryDialect !== "none" && phases.query === null) {
      const q = await waitForQuery(queries, serverId, queryWait);
      notes.query = { online: q.online, error: q.error, name: q.name };
      if (!q.online) throw new Error(`query_offline: ${q.error ?? "unknown"}`);
      phases.query = "ok";
    } else if (meta.queryDialect === "none") {
      phases.query = "skipped";
    }

    if (meta.adminDialect && meta.adminDialect !== "none") {
      try {
        const admin = await execConsoleCommand(servers, serverId, "list");
        notes.admin = { dialect: admin.dialect, ok: admin.ok, error: admin.error };
        phases.admin = admin.ok ? "ok" : "soft";
      } catch (err) {
        notes.admin = { error: err instanceof Error ? err.message : String(err) };
        phases.admin = "soft";
      }
    } else {
      phases.admin = "skipped";
    }

    if (runTools) {
      try {
        const port = servers.gamePortForSkill(meta.name) || tcp[0]?.default || 0;
        await panel.publish({
          serverId,
          blocks: [
            {
              type: "join_info",
              title: "Lab matrix",
              body: { address: "127.0.0.1", port },
              sortOrder: 0,
            },
          ],
        });
        phases.panel = "ok";
      } catch (err) {
        notes.panel = err instanceof Error ? err.message : String(err);
        phases.panel = "soft";
      }
      try {
        await snapshots.create(serverId, "lab-matrix");
        phases.snapshot = "ok";
      } catch (err) {
        notes.snapshot = err instanceof Error ? err.message : String(err);
        phases.snapshot = "soft";
      }
      try {
        await servers.restart(serverId);
        await sleep(5000);
        phases.tools = "ok";
      } catch (err) {
        notes.tools = err instanceof Error ? err.message : String(err);
        phases.tools = "soft";
      }
    }

    await servers.stop(serverId);
    phases.stop = "ok";
    await servers.remove(serverId);
    dockerCleanup(serverId);
    phases.cleanup = "ok";
    serverId = null;

    const hardFail = ["create", "start", "port_open", "stop", "cleanup"].some(
      (k) => phases[k] === "fail" || phases[k] === null,
    );
    // query hard-required when dialect set
    const queryFail = meta.queryDialect !== "none" && phases.query !== "ok";

    return {
      skillName: meta.name,
      ok: !hardFail && !queryFail,
      skipped: false,
      serverId: notes.serverId,
      phases,
      notes,
      durationMs: Date.now() - startedAt,
      tail: queryFail ? notes.query?.error ?? "query_failed" : null,
    };
  } catch (err) {
    const tail = err instanceof Error ? err.message : String(err);
    if (serverId) {
      await safeCleanup(servers, serverId);
      phases.cleanup = phases.cleanup ?? "ok";
    }
    // mark first null phase as fail
    for (const key of Object.keys(phases)) {
      if (phases[key] === null) {
        phases[key] = "fail";
        break;
      }
    }
    return {
      skillName: meta.name,
      ok: false,
      skipped: false,
      serverId: notes.serverId ?? serverId,
      phases,
      notes,
      durationMs: Date.now() - startedAt,
      tail,
    };
  }
}

async function safeCleanup(servers, serverId) {
  try {
    await servers.stop(serverId);
  } catch {
    /* ignore */
  }
  try {
    await servers.remove(serverId);
  } catch {
    /* ignore */
  }
  dockerCleanup(serverId);
}

async function main() {
  ensureDist();

  if (!["static", "lifecycle", "tools", "all"].includes(tier)) {
    console.error(`unknown --tier ${tier}`);
    process.exit(2);
  }

  const gamesRoot = resolveGamesRoot();
  if (!gamesRoot) {
    console.error(
      "games skills root not found. Checkout sibling playon-games or set PLAYON_GAMES_SKILLS_ROOT.",
    );
    process.exit(2);
  }
  if (source === "catalog") {
    console.error("--source catalog not implemented yet; use sibling (default).");
    process.exit(2);
  }

  const platformRoot = path.join(repoRoot, "skills", "platform");
  const swept = sweepStaleMatrixTempRoots({ maxAgeMs: 3600_000 });
  if (swept > 0) console.log(`lab-matrix reclaimed ${swept} stale temp root(s)`);
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playon-lab-matrix-"));
  assertSafeDataRoot(dataRoot);
  const dbPath = path.join(dataRoot, "playon.db");
  applyBootstrap(dbPath);
  const { db, sqlite } = createDb(dbPath);

  let exitCode = 0;
  const finalizeTemp = () => {
    try {
      sqlite.close();
    } catch {
      /* already closed */
    }
    removeDataRoot(dataRoot);
  };
  const onSignal = (sig) => {
    console.warn(`lab-matrix caught ${sig}; cleaning temp dataRoot`);
    finalizeTemp();
    process.exit(130);
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  try {
    exitCode = await runMatrixBody({
      dataRoot,
      db,
      sqlite,
      skillsRoots: [gamesRoot, platformRoot, path.join(dataRoot, "skills")],
      gamesRoot,
    });
  } finally {
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    finalizeTemp();
  }
  process.exit(exitCode);
}

async function runMatrixBody({ dataRoot, db, sqlite, skillsRoots, gamesRoot }) {
  const dbPath = path.join(dataRoot, "playon.db");
  const advertiseHost = matrixAdvertiseHost();
  const config = {
    port: 0,
    dataRoot,
    dbPath,
    sessionSecret: "lab-matrix-secret",
    llmMode: "openai_compatible",
    runtimeMode: process.env.PLAYON_RUNTIME === "native" ? "native" : "docker",
    skillsRoots,
    advertiseHost,
  };
  console.log(`lab-matrix advertiseHost=${advertiseHost}`);

  // Docker preflight only when we will start servers
  if (tier !== "static" && config.runtimeMode === "docker") {
    const adapters = await createRuntimeAdapters("docker");
    if (adapters.mode !== "docker") {
      console.error("expected docker runtime");
      return 2;
    }
  }

  const cp = createControlPlane(db, config);
  const winCfg = windowsPlacementConfig(repoRoot);
  let windows = { enabled: false };
  if (winCfg.enabled && tier !== "static") {
    try {
      const auth = await loadHomeAuth(winCfg);
      const home = new HomeClient(auth);
      const node = await home.requireWinNodeOnline(winCfg.winNodeId);
      windows = {
        enabled: true,
        home,
        winNodeId: winCfg.winNodeId,
        winHost: winCfg.winHost,
      };
      console.log(
        `lab-matrix windows placement node=${winCfg.winNodeId} host=${winCfg.winHost} status=${node.status}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`lab-matrix windows placement disabled: ${msg}`);
      windows = { enabled: false };
    }
  }

  const allSkills = listSkills(skillsRoots)
    .filter((s) => s.metadata.name.startsWith("games."))
    .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));

  if (!windows.enabled && filter === "windows") {
    console.error("windows placement unavailable (is playon-win-1 online?)");
    return 2;
  }

  let selected = allSkills;
  if (onlySkill) {
    selected = allSkills.filter((s) => s.metadata.name === onlySkill);
    if (!selected.length) {
      console.error(`skill not found: ${onlySkill}`);
      return 2;
    }
  }
  if (filter) {
    const before = selected.length;
    selected = selected.filter((s) => {
      const m = s.metadata;
      const isDocker = m.containerSupport === "full" && !!m.dockerImage;
      const isSteam = typeof m.steamAppId === "number";
      if (filter === "docker") return isDocker;
      // Steam includes Windows-only / PE titles — dual-place routes them to playon-win-1.
      if (filter === "steam") return isSteam;
      if (filter === "windows") return wantsWindowsPlacement(m);
      if (filter === "native") return !isDocker;
      if (filter === "other") return !isDocker && !isSteam;
      return true;
    });
    if (!["docker", "steam", "native", "other", "windows"].includes(filter)) {
      console.error(`unknown --filter ${filter} (docker|steam|native|other|windows)`);
      return 2;
    }
    console.log(`filter=${filter} ${before} → ${selected.length}`);
  }
  if (fromSkill) {
    const idx = selected.findIndex((s) => s.metadata.name === fromSkill);
    if (idx === -1) {
      console.error(`--from skill not in set: ${fromSkill}`);
      return 2;
    }
    selected = selected.slice(idx);
  }

  const prev = resume ? loadStatus() : null;
  const alreadyOk = new Set(
    (prev?.results ?? []).filter((r) => r.ok).map((r) => r.skillName),
  );

  const startedAt = new Date().toISOString();
  const results = resume ? [...(prev?.results ?? []).filter((r) => r.ok)] : [];
  let failedSkill = null;

  console.log(`lab-matrix dataRoot=${dataRoot}`);
  console.log(`lab-matrix gamesRoot=${gamesRoot}`);
  console.log(`lab-matrix skills=${selected.length} tier=${tier} resume=${resume}`);

  for (let i = 0; i < selected.length; i++) {
    const skill = selected[i];
    const name = skill.metadata.name;
    if (resume && alreadyOk.has(name) && !onlySkill) {
      console.log(`skip ok: ${name}`);
      continue;
    }

    // tools-only mode: only archetypes
    if (tier === "tools" && !TOOLS_ARCHETYPES.includes(name)) {
      continue;
    }

    console.log(`\n==> [${i + 1}/${selected.length}] ${name}`);
    const runTools =
      tier === "tools" || (tier === "all" && TOOLS_ARCHETYPES.includes(name));

    let result;
    if (tier === "static") {
      const phases = phaseMap();
      const t0 = Date.now();
      try {
        await runStatic(skill, skillsRoots);
        phases.static = "ok";
        result = {
          skillName: name,
          ok: true,
          skipped: false,
          phases,
          durationMs: Date.now() - t0,
        };
      } catch (err) {
        phases.static = "fail";
        result = {
          skillName: name,
          ok: false,
          skipped: false,
          phases,
          durationMs: Date.now() - t0,
          tail: err instanceof Error ? err.message : String(err),
        };
      }
    } else {
      // static preflight then lifecycle
      try {
        await runStatic(skill, skillsRoots);
      } catch (err) {
        result = {
          skillName: name,
          ok: false,
          skipped: false,
          phases: { ...phaseMap(), static: "fail" },
          durationMs: 0,
          tail: err instanceof Error ? err.message : String(err),
        };
        results.push(result);
        failedSkill = name;
        appendIssue({
          skill: name,
          phase: "static",
          errorClass: "skill_bug",
          tail: result.tail,
        });
        writeStatus({
          ok: false,
          startedAt,
          finishedAt: new Date().toISOString(),
          mode: onlySkill ? "single" : resume ? "resume" : "catalog",
          dataRoot,
          skillsSource: source,
          skillsRequested: selected.map((s) => s.metadata.name),
          skillsRun: results.map((r) => r.skillName),
          cursor: i,
          failedSkill: name,
          results,
          nextAction: `Fix ${name}, then: pnpm lab:matrix --resume`,
        });
        console.log(
          `result ${name} ok=false skipped=false  duration_ms=0`,
        );
        console.log(`tail: ${result.tail}`);
        if (!continueOnFail) break;
        continue;
      }
      result = await runLifecycle(cp, skill, { runTools, windows });
    }

    // replace prior non-ok entry for this skill when resuming
    const existingIdx = results.findIndex((r) => r.skillName === name);
    if (existingIdx >= 0) results.splice(existingIdx, 1);
    results.push(result);

    const status = {
      ok: result.ok && !failedSkill,
      startedAt,
      finishedAt: new Date().toISOString(),
      mode: onlySkill ? "single" : resume ? "resume" : "catalog",
      dataRoot,
      skillsSource: source,
      skillsRequested: selected.map((s) => s.metadata.name),
      skillsRun: results.map((r) => r.skillName),
      cursor: i,
      failedSkill: result.ok ? null : name,
      results,
      nextAction: result.ok
        ? "Continue matrix or pick next skill."
        : `Fix ${name}, then: pnpm lab:matrix --resume`,
    };
    // ok at top level is "run finished without hard failure so far"
    status.ok = results.every((r) => r.ok);
    if (!result.ok) {
      status.failedSkill = name;
      failedSkill = name;
      appendIssue({
        skill: name,
        phase: Object.entries(result.phases).find(([, v]) => v === "fail")?.[0] ?? "unknown",
        errorClass: "lifecycle_fail",
        tail: result.tail,
      });
    }
    writeStatus(status);

    console.log(
      `result ${name} ok=${result.ok} skipped=${!!result.skipped} ${result.skipReason ?? ""} duration_ms=${result.durationMs}`,
    );
    if (result.tail) console.log(`tail: ${result.tail}`);

    if (!result.ok && !continueOnFail) break;
  }

  // Temp dataRoot / sqlite closed by main()'s finally (also on SIGINT/SIGTERM).

  const final = loadStatus();
  console.log("\n==> lab-matrix summary");
  console.log(`status_file=${STATUS_PATH}`);
  console.log(`ok=${final?.ok}`);
  const okN = results.filter((r) => r.ok && !r.skipped).length;
  const skipN = results.filter((r) => r.skipped).length;
  const failN = results.filter((r) => !r.ok).length;
  console.log(`passed=${okN} skipped=${skipN} failed=${failN}`);

  // Close the SDLC loop: matrix failures → GitHub needs-triage (source:lab)
  if (failN > 0 && (process.env.PLAYON_LAB_FILE_ISSUES ?? "1") !== "0") {
    try {
      execSync(`${process.execPath} scripts/lab-file-github-issues.mjs --from matrix`, {
        cwd: repoRoot,
        stdio: "inherit",
        env: process.env,
      });
    } catch {
      console.warn("lab-file-github-issues failed (non-fatal for matrix exit)");
    }
  }

  if (failedSkill) {
    console.log(`FAILED skill=${failedSkill}`);
    console.log(final?.nextAction);
    return 1;
  }
  console.log(final?.nextAction ?? "done");
  return 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
