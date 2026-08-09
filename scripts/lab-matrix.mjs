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
}

function appendIssue(issue) {
  fs.mkdirSync(path.dirname(ISSUES_PATH), { recursive: true });
  fs.appendFileSync(ISSUES_PATH, `${JSON.stringify({ at: new Date().toISOString(), ...issue })}\n`);
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

    const created = await home.tool("servers_create_from_skill", {
      skillName: meta.name,
      serverName: `lab-matrix-${skillSlug(meta.name)}`,
      nodeId: winNodeId,
    });
    serverId = created.serverId;
    if (!serverId) throw new Error("create_missing_serverId");
    notes.serverId = serverId;
    notes.runtimeMode = created.runtimeMode;
    phases.create = "ok";

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
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Exit 8 / No subscription: paid depot under anonymous SteamCMD.
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
        throw err;
      }
    } else {
      phases.install = "skipped";
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
        const detail = await home.rest(`/api/servers/${serverId}`);
        const status = detail?.server?.status ?? detail?.status;
        running = status === "running";
        if (running) break;
        await sleep(3000);
      }
      if (!running) throw new Error("udp_process_not_running");
      phases.port_open = "ok";
    } else {
      const detail = await home.rest(`/api/servers/${serverId}`);
      const status = detail?.server?.status ?? detail?.status;
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
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playon-lab-matrix-"));
  assertSafeDataRoot(dataRoot);
  const dbPath = path.join(dataRoot, "playon.db");
  applyBootstrap(dbPath);
  const { db, sqlite } = createDb(dbPath);

  const skillsRoots = [gamesRoot, platformRoot, path.join(dataRoot, "skills")];
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
      process.exit(2);
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
    process.exit(2);
  }

  let selected = allSkills;
  if (onlySkill) {
    selected = allSkills.filter((s) => s.metadata.name === onlySkill);
    if (!selected.length) {
      console.error(`skill not found: ${onlySkill}`);
      process.exit(2);
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
      process.exit(2);
    }
    console.log(`filter=${filter} ${before} → ${selected.length}`);
  }
  if (fromSkill) {
    const idx = selected.findIndex((s) => s.metadata.name === fromSkill);
    if (idx === -1) {
      console.error(`--from skill not in set: ${fromSkill}`);
      process.exit(2);
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
        break;
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

  sqlite.close();
  try {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  } catch {
    console.warn(`temp dataRoot left at ${dataRoot}`);
  }

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
    process.exit(1);
  }
  console.log(final?.nextAction ?? "done");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
