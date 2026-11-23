/**
 * Live clone-isolation runner.
 *
 * For each package: start a stand-in that holds the live server's ports and
 * save, copy that server's start settings onto a clone, then either give the
 * clone its own identity or refuse to start it. The stand-in's process, ports,
 * and save must be unchanged. Cleanup removes the stand-ins and temp dirs.
 *
 * `--home` also drives a running lab Home. It will not run when that Home
 * already hosts a live player server (NZL / Hub / Frontier).
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import dgram from "node:dgram";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planClone } from "./scan.mjs";

const STANDIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "clone-isolation-standin.mjs");

export const LIVE_PLAYER_NAMES = ["newzombieland3", "hub", "frontier", "nzl-clone-frontier-rd"];

export function isLivePlayerName(name) {
  const value = String(name ?? "").trim().toLowerCase();
  if (!value) return false;
  if (value.startsWith("lab-live-") || value.startsWith("lab-clone-")) return false;
  return LIVE_PLAYER_NAMES.includes(value) || value.includes("newzombieland");
}

export function assertHomeIsLab(servers) {
  for (const server of servers ?? []) {
    if (isLivePlayerName(server?.name)) {
      throw new Error(
        `refusing clone isolation: Home already hosts live player server "${server.name}" (${server.id}). ` +
          `Run this on a lab machine that does not serve NZL, Hub, or Frontier. ` +
          `Do not register the production host as playon-lab-linux or playon-lab-windows.`,
      );
    }
  }
}

export function assertLabServerName(name) {
  const value = String(name ?? "");
  if (!value.startsWith("lab-live-") && !value.startsWith("lab-clone-")) {
    throw new Error(`refusing to create or delete "${value}"; only lab-live-* and lab-clone-*`);
  }
}

export function selectPackages(packages, opts = {}) {
  let chosen = packages.slice();
  if (opts.host && opts.host !== "all") {
    const { packageRunsOn } = opts;
    chosen = chosen.filter((pkg) => (packageRunsOn ? packageRunsOn(pkg.metadata, opts.host) : true));
  }
  if (opts.skill) {
    const want = new Set(
      String(opts.skill)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    );
    chosen = chosen.filter((pkg) => want.has(pkg.metadata.name));
  }
  if (opts.shard) {
    const match = String(opts.shard).match(/^(\d+)\s*\/\s*(\d+)$/);
    if (!match) throw new Error(`shard must look like 1/4, got ${opts.shard}`);
    const index = Number(match[1]);
    const count = Number(match[2]);
    if (index < 1 || index > count) throw new Error(`shard ${opts.shard} is out of range`);
    chosen = chosen.filter((_, i) => i % count === index - 1);
  }
  const limit = Number(opts.limit ?? 0);
  if (limit > 0) chosen = chosen.slice(0, limit);
  return chosen;
}

function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function renderStartEnv(identity) {
  const lines = ["# copied start settings — Home must rewrite these per server"];
  lines.push(`PLAYON_SERVER_NAME=${JSON.stringify(identity.name)}`);
  lines.push(`PLAYON_SERVER_ID=${JSON.stringify(identity.id)}`);
  const game = identity.ports.find((port) => port.name === "game") ?? identity.ports[0];
  if (game) lines.push(`PLAYON_GAME_PORT=${JSON.stringify(String(game.port))}`);
  const direct = identity.ports.find((port) => port.name === "direct");
  if (direct) lines.push(`PLAYON_DIRECT_PORT=${JSON.stringify(String(direct.port))}`);
  lines.push(`PLAYON_HOME=${JSON.stringify(identity.dataDir)}`);
  lines.push("");
  return lines.join("\n");
}

function shiftPorts(ports, base) {
  return ports.map((port, index) => ({ ...port, port: base + index }));
}

async function portBusy(port) {
  const protocol = port.protocol === "tcp" ? "tcp" : "udp";
  try {
    if (protocol === "tcp") {
      await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(port.port, "127.0.0.1", () => server.close(resolve));
      });
    } else {
      await new Promise((resolve, reject) => {
        const socket = dgram.createSocket("udp4");
        socket.once("error", reject);
        socket.bind(port.port, "127.0.0.1", () => socket.close(resolve));
      });
    }
    return false;
  } catch (err) {
    if (err && err.code === "EADDRINUSE") return true;
    throw err;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopChild(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  child.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForReady(file, child) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (child.exitCode != null) {
      throw new Error(`stand-in exited ${child.exitCode} before it was ready`);
    }
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`stand-in did not become ready (${file})`);
}

async function spawnStandin(spec) {
  const child = spawn(process.execPath, [STANDIN], {
    env: { ...process.env, PLAYON_STANDIN_SPEC: JSON.stringify(spec) },
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    const ready = await waitForReady(spec.readyPath, child);
    return { child, pid: ready.pid };
  } catch (err) {
    await stopChild(child);
    throw err;
  }
}

async function removeTree(dir) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 4) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

/**
 * Run one package. Returns `{ ok, action, name, error }`. Throws only when the
 * stand-in itself cannot be cleaned up.
 */
export async function runPackageIsolation(pkg, opts = {}) {
  if (process.env.PLAYON_PRODUCTION_HOST === "1") {
    throw new Error(
      "PLAYON_PRODUCTION_HOST=1: refusing to bind ports. This check must run on a lab machine, not the production host.",
    );
  }
  const plan = planClone(pkg);
  const name = pkg.metadata.name;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-clone-isolation-"));
  const children = [];
  try {
    const livePorts = opts.portBase ? shiftPorts(plan.live.ports, opts.portBase) : plan.live.ports;
    const clonePorts = opts.portBase
      ? shiftPorts(plan.clone.ports, opts.portBase + 100)
      : plan.clone.ports;
    const liveSave = path.join(root, "live", "home", "save", "sentinel.bin");
    const liveBody = `live ${plan.live.id} ${name}\n`;
    const copiedEnv = renderStartEnv({ ...plan.live, ports: livePorts, dataDir: path.join(root, "live", "home") });
    const rewrittenEnv = renderStartEnv({
      ...plan.clone,
      ports: clonePorts,
      dataDir: path.join(root, "clone", "home"),
    });
    fs.mkdirSync(path.join(root, "live", "game"), { recursive: true });
    fs.mkdirSync(path.join(root, "clone", "game"), { recursive: true });
    fs.writeFileSync(path.join(root, "copied-from-live.env"), copiedEnv);
    fs.writeFileSync(path.join(root, "clone", "game", ".playon-start.env"), rewrittenEnv);
    for (const [rel, text] of Object.entries(pkg.files ?? {})) {
      if (!/(^|\/)start\.(sh|bat|ps1|cmd)$/.test(rel)) continue;
      const file = path.join(root, "clone", "game", path.basename(rel));
      fs.writeFileSync(file, text);
    }

    let live;
    try {
      live = await spawnStandin({
        name: plan.live.name,
        ports: livePorts,
        savePath: liveSave,
        saveBody: liveBody,
        readyPath: path.join(root, "live.ready"),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/EADDRINUSE|exited/.test(message)) {
        return {
          ok: false,
          name,
          action: plan.action,
          error:
            `port_busy: refusing to take ${livePorts.map((port) => port.port).join(",")} on 127.0.0.1 ` +
            `(${message}). This runner must not be a machine that already hosts that game. ` +
            `No process was killed.`,
        };
      }
      throw err;
    }
    children.push(live.child);
    const saveHash = hashFile(liveSave);

    let clonePid = null;
    if (plan.action === "isolate") {
      const cloneSave = path.join(root, "clone", "home", "save", "sentinel.bin");
      const clone = await spawnStandin({
        name: plan.clone.name,
        ports: clonePorts,
        savePath: cloneSave,
        saveBody: `clone ${plan.clone.id} ${name}\n`,
        readyPath: path.join(root, "clone.ready"),
      });
      children.push(clone.child);
      clonePid = clone.pid;
      if (clone.pid === live.pid) throw new Error(`${name}: clone reused the live stand-in process`);
      if (hashFile(cloneSave) === saveHash) throw new Error(`${name}: clone save matches the live save`);
      if (path.resolve(cloneSave) === path.resolve(liveSave)) {
        throw new Error(`${name}: clone save path is the live save path`);
      }
      const cloneEnv = fs.readFileSync(path.join(root, "clone", "game", ".playon-start.env"), "utf8");
      if (cloneEnv.includes(plan.live.id) || cloneEnv.includes(path.join(root, "live"))) {
        throw new Error(`${name}: rewritten clone env still points at the live server`);
      }
    } else if (!plan.error) {
      throw new Error(`${name}: refuse plan has no error`);
    }

    if (!alive(live.pid)) throw new Error(`${name}: live stand-in died`);
    if (hashFile(liveSave) !== saveHash) throw new Error(`${name}: live save changed`);
    for (const port of livePorts) {
      if (!(await portBusy(port))) throw new Error(`${name}: live port ${port.port}/${port.protocol} was released`);
    }
    if (plan.action === "refuse") {
      for (const port of clonePorts) {
        if (livePorts.some((livePort) => livePort.port === port.port)) continue;
        if (await portBusy(port)) {
          throw new Error(`${name}: refused clone still bound ${port.port}`);
        }
      }
    }
    const copied = fs.readFileSync(path.join(root, "copied-from-live.env"), "utf8");
    if (!copied.includes(plan.live.name)) throw new Error(`${name}: copied start settings lost the live name`);

    return {
      ok: true,
      name,
      action: plan.action,
      error: plan.error,
      livePid: live.pid,
      clonePid,
    };
  } finally {
    for (const child of children) await stopChild(child);
    await removeTree(root);
  }
}

export function dryRunPlans(packages) {
  return packages.map((pkg) => {
    const plan = planClone(pkg);
    const game = plan.live.ports.find((port) => port.name === "game") ?? plan.live.ports[0];
    return {
      name: pkg.metadata.name,
      action: plan.action,
      error: plan.error,
      livePort: game?.port ?? null,
      clonePort: plan.clone.ports.find((port) => port.name === game?.name)?.port ?? null,
      os: pkg.metadata.os,
    };
  });
}

export async function runStandinMatrix(packages, opts = {}) {
  const results = [];
  for (const pkg of packages) {
    results.push(await runPackageIsolation(pkg, opts));
    const last = results[results.length - 1];
    if (opts.onResult) opts.onResult(last);
    if (!last.ok && !opts.continueOnFail) break;
  }
  return results;
}

function cookieHeader(session) {
  return { cookie: `playon_session=${session}`, "content-type": "application/json" };
}

async function homeJson(fetchImpl, url, session, init = {}) {
  const response = await fetchImpl(url, {
    ...init,
    headers: { ...cookieHeader(session), ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text.slice(0, 300) };
  }
  return { status: response.status, body };
}

/**
 * Create lab-live / lab-clone rows on a running Home, copy start settings onto
 * the clone, optionally start it, then delete only those rows (snapshots and
 * jails go with DELETE /api/servers/:id).
 */
export async function runHomePhase({ api, session, packages, fetchImpl = fetch, start = false }) {
  if (!session) throw new Error("home phase needs PLAYON_LAB_HOME_SESSION");
  const base = api.replace(/\/$/, "");
  const listed = await homeJson(fetchImpl, `${base}/api/servers`, session);
  if (listed.status === 403 || listed.status === 401) {
    throw new Error(`home auth failed (${listed.status}); the session cannot list servers`);
  }
  if (listed.status !== 200) {
    throw new Error(`home list failed (${listed.status})`);
  }
  assertHomeIsLab(listed.body?.servers ?? []);
  const skillsRes = await homeJson(fetchImpl, `${base}/api/skills`, session);
  const installed = new Set((skillsRes.body?.skills ?? []).map((skill) => skill.name));
  const created = [];
  const results = [];
  try {
    for (const pkg of packages) {
      const name = pkg.metadata.name;
      if (!installed.has(name)) {
        results.push({ ok: true, name, action: "skip", error: "skill_not_installed" });
        continue;
      }
      const plan = planClone(pkg);
      assertLabServerName(plan.live.name);
      assertLabServerName(plan.clone.name);
      const liveRes = await homeJson(fetchImpl, `${base}/api/servers`, session, {
        method: "POST",
        body: JSON.stringify({ skillName: name, serverName: plan.live.name }),
      });
      if (liveRes.status >= 400) {
        results.push({
          ok: false,
          name,
          action: "home",
          error: `create live failed (${liveRes.status}) ${liveRes.body?.error ?? ""}`.trim(),
        });
        continue;
      }
      const live = liveRes.body?.server;
      created.push(live);
      const cloneRes = await homeJson(fetchImpl, `${base}/api/servers`, session, {
        method: "POST",
        body: JSON.stringify({ skillName: name, serverName: plan.clone.name }),
      });
      if (cloneRes.status >= 400) {
        results.push({
          ok: false,
          name,
          action: "home",
          error: `create clone failed (${cloneRes.status}) ${cloneRes.body?.error ?? ""}`.trim(),
        });
        continue;
      }
      const clone = cloneRes.body?.server;
      created.push(clone);
      if (live?.dataPath && clone?.dataPath && live.dataPath === clone.dataPath) {
        results.push({ ok: false, name, action: "home", error: "clone dataPath equals the live dataPath" });
        continue;
      }
      const snap = await homeJson(fetchImpl, `${base}/api/snapshots`, session, {
        method: "POST",
        body: JSON.stringify({ serverId: live.id, label: "lab-clone-isolation" }),
      });
      if (snap.status >= 400) {
        results.push({
          ok: false,
          name,
          action: "home",
          error: `snapshot failed (${snap.status}) ${snap.body?.error ?? ""}`.trim(),
        });
        continue;
      }
      if (live?.dataPath && clone?.dataPath && fs.existsSync(live.dataPath) && fs.existsSync(clone.dataPath)) {
        const game = path.join(clone.dataPath, "game");
        fs.mkdirSync(path.join(live.dataPath, "game"), { recursive: true });
        fs.mkdirSync(game, { recursive: true });
        const copied = renderStartEnv({ ...plan.live, dataDir: path.join(live.dataPath, "home") });
        const rewritten = renderStartEnv({ ...plan.clone, dataDir: path.join(clone.dataPath, "home") });
        fs.writeFileSync(path.join(live.dataPath, "game", ".playon-start.env"), copied);
        fs.writeFileSync(path.join(game, ".playon-start.env"), rewritten);
        const onDisk = fs.readFileSync(path.join(game, ".playon-start.env"), "utf8");
        if (onDisk.includes(live.id)) {
          results.push({ ok: false, name, action: "home", error: "clone env still names the live server id" });
          continue;
        }
      }
      if (!start) {
        results.push({ ok: true, name, action: plan.action, error: plan.error, home: "created" });
        continue;
      }
      const started = await homeJson(fetchImpl, `${base}/api/servers/${clone.id}/start`, session, {
        method: "POST",
        body: "{}",
      });
      const message = String(started.body?.error ?? started.body?.message ?? "");
      const refused = /start_identity_|start_port_collision|start_config_/.test(message);
      if (plan.action === "refuse" && refused) {
        results.push({ ok: true, name, action: "refuse", error: message, home: "refused" });
      } else if (plan.action === "isolate" && started.status < 400) {
        results.push({ ok: true, name, action: "isolate", error: null, home: "started" });
      } else if (plan.action === "refuse" && started.status < 400) {
        results.push({
          ok: false,
          name,
          action: "refuse",
          error: `Home started a clone that should have been refused (${started.status})`,
        });
      } else {
        results.push({
          ok: false,
          name,
          action: plan.action,
          error: `unexpected home start (${started.status}) ${message}`.trim(),
        });
      }
    }
  } finally {
    for (const server of created.reverse()) {
      if (!server?.id) continue;
      assertLabServerName(server.name);
      await homeJson(fetchImpl, `${base}/api/servers/${server.id}`, session, { method: "DELETE" });
    }
  }
  return results;
}
