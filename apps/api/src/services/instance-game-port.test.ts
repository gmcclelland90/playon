import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { probeUdpListen } from "@playon/runtime";
import { createDb } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import type { AppConfig } from "../config.js";
import { resolveFixturesRoot } from "../lab-games-root.js";
import { listLocalIniRelPaths } from "./instance-game-port-files.js";
import { ServerService } from "./servers.js";

const temps: Array<{ root: string; sqlite: Database.Database }> = [];
const sockets: dgram.Socket[] = [];

function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function writePzSkill(skillsRoot: string): void {
  const skillDir = path.join(skillsRoot, "games", "project-zomboid");
  fs.mkdirSync(path.join(skillDir, "guides"), { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "metadata.yaml"),
    [
      "name: games.project-zomboid",
      "version: 0.1.0",
      "game: Project Zomboid",
      "description: pz",
      "containerSupport: none",
      "ports:",
      "  - name: game",
      "    protocol: udp",
      "    default: 16261",
      "healthChecks: []",
      "dependencies: []",
      "requiredTools: []",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(skillDir, "guides", "INSTALL.md"), "# PZ\n");
}

function writeInstanceIni(
  dataPath: string,
  name: string,
  defaultPort: number,
  udpPort: number,
): void {
  const dir = path.join(dataPath, "home", "Zomboid", "Server");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.ini`),
    [`DefaultPort=${defaultPort}`, `UDPPort=${udpPort}`, `PublicName=${name}`, ""].join("\n"),
  );
}

function tempPzEnv(): { config: AppConfig; servers: ServerService } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-instance-port-"));
  const dbPath = path.join(root, "playon.sqlite");
  applyBootstrap(dbPath);
  const { db, sqlite } = createDb(dbPath);
  temps.push({ root, sqlite });
  writePzSkill(path.join(root, "skills"));
  const config: AppConfig = {
    port: 0,
    dataRoot: root,
    dbPath,
    sessionSecret: "instance-port-test",
    llmMode: "openai_compatible",
    runtimeMode: "native",
    skillsRoots: [path.join(root, "skills"), resolveFixturesRoot(findRepoRoot(process.cwd()))],
    advertiseHost: "127.0.0.1",
  };
  return { config, servers: new ServerService(db, config) };
}

function bindUdp(port = 0): Promise<{ socket: dgram.Socket; port: number }> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", reject);
    socket.bind(port, "127.0.0.1", () => {
      const addr = socket.address();
      if (typeof addr === "string") {
        socket.close();
        reject(new Error("udp_bind_failed"));
        return;
      }
      sockets.push(socket);
      resolve({ socket, port: addr.port });
    });
  });
}

afterEach(() => {
  while (sockets.length) {
    const socket = sockets.pop();
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
  }
  while (temps.length) {
    const entry = temps.pop();
    if (!entry) break;
    try {
      entry.sqlite.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(entry.root, { recursive: true, force: true });
  }
});

describe("instance DefaultPort vs skill default 16261", () => {
  it("lists PZ Hub.ini under home/Zomboid/Server", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-ini-walk-"));
    try {
      writeInstanceIni(root, "Hub", 16271, 16272);
      expect(listLocalIniRelPaths(root)).toContain("home/Zomboid/Server/Hub.ini");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("joinInfoFor returns each instance DefaultPort and leaves skill default 16261 for NZL-style", async () => {
    const { servers } = tempPzEnv();
    const nzl = await servers.createFromSkill({
      skillName: "games.project-zomboid",
      serverName: "NZL",
    });
    const hub = await servers.createFromSkill({
      skillName: "games.project-zomboid",
      serverName: "Hub",
    });
    const frontier = await servers.createFromSkill({
      skillName: "games.project-zomboid",
      serverName: "Frontier",
    });
    writeInstanceIni(hub.dataPath, "Hub", 16271, 16272);
    writeInstanceIni(frontier.dataPath, "Frontier", 16265, 16266);
    writeInstanceIni(nzl.dataPath, "NZL", 16261, 16262);

    expect(servers.gamePortForSkill("games.project-zomboid")).toBe(16261);
    expect(await servers.joinInfoFor(nzl)).toMatchObject({ port: 16261 });
    expect(await servers.joinInfoFor(hub)).toMatchObject({ port: 16271 });
    expect(await servers.joinInfoFor(frontier)).toMatchObject({ port: 16265 });
  });

  it("falls back to skill default 16261 when the instance has no DefaultPort", async () => {
    const { servers } = tempPzEnv();
    const created = await servers.createFromSkill({
      skillName: "games.project-zomboid",
      serverName: "Bare",
    });
    expect(await servers.joinInfoFor(created)).toMatchObject({ port: 16261 });
  });

  it("health/reap bind evidence uses the instance port, not skill default 16261", async () => {
    const prevSkip = process.env.PLAYON_SKIP_HOST_PORT_PROBE;
    delete process.env.PLAYON_SKIP_HOST_PORT_PROBE;
    try {
      const { servers } = tempPzEnv();
      const hub = await servers.createFromSkill({
        skillName: "games.project-zomboid",
        serverName: "Hub",
      });
      const frontier = await servers.createFromSkill({
        skillName: "games.project-zomboid",
        serverName: "Frontier",
      });
      const bound = await bindUdp();
      writeInstanceIni(hub.dataPath, "Hub", bound.port, bound.port + 1);
      writeInstanceIni(frontier.dataPath, "Frontier", 16265, 16266);
      servers.portDeadGraceMs = 0;

      const hubHealth = await servers.evaluateHostPortsHealth({ ...hub, status: "running" });
      const frontierHealth = await servers.evaluateHostPortsHealth({
        ...frontier,
        status: "running",
      });
      const skillDefault = probeUdpListen(16261);

      if (probeUdpListen(bound.port).probe === "unavailable") {
        expect(hubHealth.ok).toBe(true);
        expect(hubHealth.detail).toMatch(/skipped or unknown/);
        return;
      }

      expect(skillDefault.listening).not.toBe(true);
      expect(await servers.hostGamePortsBound(hub)).toBe(true);
      expect(await servers.hostGamePortsBound(frontier)).toBe(false);
      expect(hubHealth.ok).toBe(true);
      expect(frontierHealth.ok).toBe(false);
      expect(await servers.joinInfoFor(hub)).toMatchObject({ port: bound.port });
      expect(await servers.joinInfoFor(frontier)).toMatchObject({ port: 16265 });
    } finally {
      if (prevSkip == null) delete process.env.PLAYON_SKIP_HOST_PORT_PROBE;
      else process.env.PLAYON_SKIP_HOST_PORT_PROBE = prevSkip;
    }
  });
});
