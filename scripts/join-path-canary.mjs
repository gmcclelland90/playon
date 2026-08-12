/**
 * Join-path canary (#843): probe published joinHost:port from resolveJoinAddress,
 * not 127.0.0.1. Fail if loopback is open but join host is not.
 *
 * Does **not** change lab-matrix `port_open` (still loopback on Linux).
 * Fixture-only — never friend servers / NZL.
 *
 *   pnpm lab:join-path-canary
 *   pnpm lab:join-path-canary --live-docker   # start fixtures.lab-docker-server (lab)
 *
 * WSL sibling / Windows PE live TCP against playon-win-1 is lab-only and not
 * started by this runner (no PE fixture in this repo; never friend worlds).
 * Address resolution for those topologies is always asserted.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  JOIN_PATH_CANARY_SKILL,
  probeJoinPath,
  wslSiblingNodeId,
} from "../packages/shared/dist/index.js";
import { createDb } from "../apps/api/dist/db/client.js";
import { applyBootstrap } from "../apps/api/dist/db/migrate.js";
import { NetToolsService } from "../apps/api/dist/services/net-tools.js";
import { ServerService } from "../apps/api/dist/services/servers.js";
import { resolveFixturesRoot } from "../apps/api/dist/lab-games-root.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(repoRoot);

const argv = process.argv.slice(2);
const liveDocker = argv.includes("--live-docker");

function firstNonLoopbackIPv4() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const e of entries ?? []) {
      if ((e.family !== "IPv4" && e.family !== 4) || e.internal) continue;
      if (e.address) return e.address;
    }
  }
  return null;
}

function listen(host, port = 0) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("listen_failed"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function skip(id, reason) {
  console.log(`join-path-canary skip topology=${id} reason=${reason}`);
}

const sharedDist = path.join(repoRoot, "packages/shared/dist/index.js");
const apiDist = path.join(repoRoot, "apps/api/dist/services/servers.js");
if (!fs.existsSync(sharedDist) || !fs.existsSync(apiDist)) {
  console.error("join-path-canary FAIL: dist missing — run `pnpm build` first");
  process.exit(1);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-join-path-"));
const dbPath = path.join(root, "playon.db");
applyBootstrap(dbPath);
const { db, sqlite } = createDb(dbPath);

const lan = firstNonLoopbackIPv4() ?? "172.16.0.156";
const winJoin = process.env.PLAYON_JOIN_PATH_WIN_HOST?.trim() || "172.16.0.94";

const config = {
  port: 0,
  dataRoot: root,
  dbPath,
  sessionSecret: "join-path-canary-secret",
  llmMode: "openai_compatible",
  runtimeMode: "docker",
  skillsRoots: [resolveFixturesRoot(repoRoot), path.join(root, "skills")],
  advertiseHost: "127.0.0.1",
};

function insertNode(values) {
  sqlite
    .prepare(
      `INSERT INTO nodes (id, name, os, docker, native, steamcmd, free_disk_bytes, last_seen_at, kind, tunnel_status, join_host)
       VALUES (@id, @name, @os, 1, 1, 1, @disk, @seen, @kind, 'none', @joinHost)`,
    )
    .run({
      id: values.id,
      name: values.name,
      os: values.os,
      disk: 1e11,
      seen: Date.now(),
      kind: values.kind ?? "lan",
      joinHost: values.joinHost ?? null,
    });
}

function placeOnNode(serverId, nodeId) {
  sqlite.prepare(`UPDATE servers SET node_id = ? WHERE id = ?`).run(nodeId, serverId);
}

let exitCode = 0;
try {
  const servers = new ServerService(db, config);
  const netTools = new NetToolsService(servers);
  const check = async (host, port) => {
    const probe = await netTools.portCheck({ host, port });
    return probe.state;
  };

  insertNode({
    id: "lab-linux-1",
    name: "lab-linux",
    os: "linux",
    joinHost: lan,
  });
  const winId = "playon-win-1";
  const wslId = wslSiblingNodeId(winId);
  insertNode({
    id: winId,
    name: "win",
    os: "windows",
    joinHost: winJoin,
  });
  insertNode({
    id: wslId,
    name: "win-wsl",
    os: "linux",
    joinHost: "172.22.144.1",
  });

  const linux = await servers.createFromSkill({
    skillName: JOIN_PATH_CANARY_SKILL,
    serverName: "Join Path Linux",
  });
  placeOnNode(linux.id, "lab-linux-1");
  const linuxJoin = await servers.joinInfoFor(await servers.get(linux.id));
  if (linuxJoin.address !== lan) {
    throw new Error(`linux topology joinHost=${linuxJoin.address} expected=${lan}`);
  }
  if (linuxJoin.port !== 25565) {
    throw new Error(`linux topology port=${linuxJoin.port} expected=25565`);
  }
  console.log(`join-path-canary ok topology=linux-docker-fixture join=${lan}:${linuxJoin.port}`);

  const wsl = await servers.createFromSkill({
    skillName: JOIN_PATH_CANARY_SKILL,
    serverName: "Join Path WSL",
  });
  placeOnNode(wsl.id, wslId);
  const wslAddr = await servers.resolveJoinAddress(await servers.get(wsl.id));
  if (wslAddr !== winJoin) {
    throw new Error(`wsl topology joinHost=${wslAddr} expected parent ${winJoin}`);
  }
  console.log(`join-path-canary ok topology=wsl-sibling join=${wslAddr} (parent join_host)`);

  const win = await servers.createFromSkill({
    skillName: JOIN_PATH_CANARY_SKILL,
    serverName: "Join Path Win PE stand-in",
  });
  placeOnNode(win.id, winId);
  const winInfo = await servers.joinInfoFor(await servers.get(win.id));
  if (winInfo.address !== winJoin) {
    throw new Error(`windows-pe topology joinHost=${winInfo.address} expected=${winJoin}`);
  }
  console.log(`join-path-canary ok topology=windows-pe join=${winJoin}:${winInfo.port} (TCP stand-in)`);

  const loopbackOnly = await listen("127.0.0.1");
  try {
    const split = await probeJoinPath({
      joinHost: lan,
      port: loopbackOnly.port,
      check,
    });
    if (split.ok || split.reason !== "loopback_open_join_host_closed") {
      throw new Error(`expected loopback_open_join_host_closed, got ${split.reason} ok=${split.ok}`);
    }
    console.log("join-path-canary ok probe=loopback_open_join_host_closed");
  } finally {
    await closeServer(loopbackOnly.server);
  }

  const allIfaces = await listen("0.0.0.0");
  try {
    const reachable = await probeJoinPath({
      joinHost: lan,
      port: allIfaces.port,
      check,
    });
    if (!reachable.ok) {
      throw new Error(
        `0.0.0.0 bind should be reachable on ${lan}:${allIfaces.port} reason=${reachable.reason}`,
      );
    }
    console.log(`join-path-canary ok probe=join_host_open host=${lan}:${allIfaces.port}`);
  } finally {
    await closeServer(allIfaces.server);
  }

  skip(
    "wsl-sibling-live",
    "lab-only: start fixtures.lab-docker-server on playon-win-1 WSL and probe parent join_host (docs/wsl-phase2-smoke-checklist.md); never friend servers",
  );
  skip(
    "windows-pe-live",
    "lab-only: disposable native TCP on playon-win-1 join_host — no PE fixture in this repo; never NZL",
  );

  if (liveDocker) {
    const liveConfig = { ...config, advertiseHost: lan };
    const liveServers = new ServerService(db, liveConfig);
    const liveNet = new NetToolsService(liveServers);
    const liveCheck = async (host, port) => {
      const probe = await liveNet.portCheck({ host, port });
      return probe.state;
    };
    const created = await liveServers.createFromSkill({
      skillName: JOIN_PATH_CANARY_SKILL,
      serverName: "Join Path Live Docker",
    });
    const name = `playon-${created.id}`;
    try {
      await liveServers.start(created.id);
      const join = await liveServers.joinInfoFor(await liveServers.get(created.id));
      if (join.address !== lan) {
        throw new Error(`live-docker joinHost=${join.address} expected advertiseHost ${lan}`);
      }
      let last = null;
      for (let i = 0; i < 60; i++) {
        last = await probeJoinPath({
          joinHost: join.address,
          port: join.port,
          check: liveCheck,
        });
        if (last.ok) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
      if (!last?.ok) {
        throw new Error(`live-docker join path ${join.address}:${join.port} reason=${last?.reason}`);
      }
      console.log(`join-path-canary ok live-docker join=${join.address}:${join.port}`);
    } finally {
      try {
        await liveServers.stop(created.id);
      } catch {
        /* ignore */
      }
      try {
        execSync(`docker rm -f ${name}`, { stdio: "ignore" });
      } catch {
        /* ignore */
      }
    }
  } else {
    skip("linux-live-docker", "pass --live-docker on the lab host (fixtures.lab-docker-server)");
  }
} catch (err) {
  exitCode = 1;
  console.error("join-path-canary FAIL:", err instanceof Error ? err.message : err);
} finally {
  try {
    sqlite.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(root, { recursive: true, force: true });
}

if (exitCode !== 0) process.exit(exitCode);
console.log("join-path-canary PASS");
