import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import type {
  ContainerSpec,
  ProcessInfo,
  ProcessSpec,
  ProcessSupervisor,
} from "@playon/runtime";
import type { NodeJobKind } from "@playon/shared";
import type { AppConfig } from "../config.js";
import { createDb, type Db } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { nodes as nodesTable, servers as serversTable } from "../db/schema.js";
import { LAB_DOCKER_SKILL, resolveFixturesRoot } from "../lab-games-root.js";
import { ServerService } from "./servers.js";

export const REMOTE_NODE_ID = "node-remote";

type FakeContainer = { id: string; name: string; status: "created" | "running" | "exited" };

const fakeCalls: string[] = [];
const fakeContainers = new Map<string, FakeContainer>();
const fakeSpecs: ContainerSpec[] = [];

export const fake = {
  calls: fakeCalls,
  containers: fakeContainers,
  specs: fakeSpecs,
  reset() {
    fakeCalls.length = 0;
    fakeContainers.clear();
    fakeSpecs.length = 0;
  },
  docker: {
    async create(spec: ContainerSpec) {
      fakeCalls.push(`create:${spec.name}`);
      fakeSpecs.push(spec);
      const info: FakeContainer = { id: `cid-${spec.name}`, name: spec.name, status: "created" };
      fakeContainers.set(spec.name, info);
      return info;
    },
    async start(id: string) {
      fakeCalls.push(`start:${id}`);
      for (const c of fakeContainers.values()) if (c.id === id) c.status = "running";
    },
    async stop(id: string) {
      fakeCalls.push(`stop:${id}`);
      for (const c of fakeContainers.values()) if (c.id === id) c.status = "exited";
    },
    async remove(id: string) {
      fakeCalls.push(`remove:${id}`);
    },
    async inspect(id: string) {
      fakeCalls.push(`inspect:${id}`);
      const hit = fakeContainers.get(id) ?? [...fakeContainers.values()].find((c) => c.id === id);
      if (!hit) throw new Error("no such container");
      return hit;
    },
    async logs(id: string, tail?: number) {
      fakeCalls.push(`logs:${id}:${tail ?? "all"}`);
      return ["fake-log"];
    },
    async followLogs(id: string, _onLine: (line: string) => void) {
      fakeCalls.push(`follow:${id}`);
      return { abort: () => fakeCalls.push(`follow-abort:${id}`) };
    },
    async writeStdin(id: string, data: string) {
      fakeCalls.push(`stdin:${id}:${data}`);
    },
  },
};

/**
 * Stands in for a node-agent: it only speaks the node job contract, and it
 * validates args and results on both shores exactly as the real seam does.
 */
type NodeContainer = { id: string; name: string; status: "created" | "running" | "exited" };
type NodeProcess = { id: string; name: string; pid?: number; status: "running" | "stopped" };
const nodeJobs: Array<{ kind: string; args: Record<string, unknown> }> = [];
const nodeContainers = new Map<string, NodeContainer>();
const nodeProcesses = new Map<string, NodeProcess>();
const nodeFiles = new Map<string, string>();
let nodeSeq = 0;

export const node = {
  jobs: nodeJobs,
  containers: nodeContainers,
  processes: nodeProcesses,
  files: nodeFiles,
  kinds(): string[] {
    return nodeJobs.map((j) => j.kind);
  },
  reset() {
    nodeJobs.length = 0;
    nodeContainers.clear();
    nodeProcesses.clear();
    nodeFiles.clear();
    nodeSeq = 0;
  },
  async dispatch(opts: { kind: string; args?: Record<string, unknown> }): Promise<unknown> {
    const { parseNodeJobArgs, parseNodeJobResult } = await import("@playon/shared");
    const kind = opts.kind as NodeJobKind;
    const args = parseNodeJobArgs(kind, opts.args ?? {}) as Record<string, unknown>;
    nodeJobs.push({ kind, args });
    const id = String(args.id ?? "");
    const found = nodeContainers.get(id) ?? [...nodeContainers.values()].find((c) => c.id === id);
    const result = ((): unknown => {
      switch (kind) {
        case "fs_ensure_dir":
          return { path: args.path, ok: true };
        case "fs_write_text":
          return { path: args.path, bytes: String(args.content ?? "").length };
        case "fs_read_text": {
          const rel = String(args.path);
          const bytes = Buffer.from(nodeFiles.get(rel) ?? "", "utf8");
          const offset = Number(args.offset ?? 0);
          const slice = bytes.subarray(
            offset,
            args.maxBytes == null ? undefined : offset + Number(args.maxBytes),
          );
          return {
            path: rel,
            content: slice.toString("utf8"),
            bytesRead: slice.length,
            truncated: offset + slice.length < bytes.length,
            size: bytes.length,
          };
        }
        case "container_inspect":
          if (!found) throw new Error("job_failed: container_inspect: no such container");
          return found;
        case "container_create": {
          const name = String(args.name);
          const created: NodeContainer = { id: `cid-${name}`, name, status: "created" };
          nodeContainers.set(name, created);
          return created;
        }
        case "container_start":
          if (found) found.status = "running";
          return { ok: true };
        case "container_stop":
          if (found) found.status = "exited";
          return { ok: true };
        case "container_logs":
          return { lines: ["node-log-1", "node-log-2"] };
        case "container_stdin":
          return { ok: true };
        case "process_status": {
          const name = String(args.name ?? "");
          return nodeProcesses.get(name) ?? { id: name, name, status: "stopped" };
        }
        case "process_start": {
          const name = String(args.name);
          const started: NodeProcess = {
            id: `native-${name}-${++nodeSeq}`,
            name,
            pid: 4200 + nodeSeq,
            status: "running",
          };
          nodeProcesses.set(name, started);
          return started;
        }
        case "process_stop":
          nodeProcesses.delete(String(args.name ?? ""));
          return { ok: true };
        default:
          throw new Error(`unexpected_job_kind_in_test: ${kind}`);
      }
    })();
    return parseNodeJobResult(kind, result);
  },
};

/**
 * Stands in for the host's process supervisor. It only answers by identity
 * (name + cwd), so nothing in the control plane can lean on a stored process id.
 */
const hostCalls: string[] = [];
const hostSpecs: ProcessSpec[] = [];
let hostRunning: ProcessInfo | null = null;
let hostSeq = 0;
const supervisor: ProcessSupervisor = {
  async start(spec) {
    hostCalls.push(`start:${spec.name}:${spec.cwd}`);
    hostSpecs.push(spec);
    hostRunning = {
      id: `native-${spec.name}-${++hostSeq}`,
      name: spec.name,
      pid: 4200 + hostSeq,
      status: "running",
    };
    return hostRunning;
  },
  async stop(id) {
    hostCalls.push(`stop:${id}`);
    hostRunning = null;
  },
  async status(id) {
    return hostRunning?.id === id ? hostRunning : { id, name: id, status: "stopped" as const };
  },
  async find(name, cwd) {
    hostCalls.push(`find:${name}:${cwd}`);
    return hostRunning;
  },
  async reclaim(name, cwd) {
    hostCalls.push(`reclaim:${name}:${cwd}`);
    hostRunning = null;
  },
  async writeStdin(name, cwd, data) {
    hostCalls.push(`stdin:${name}:${cwd}:${data}`);
  },
};

export const host = {
  calls: hostCalls,
  specs: hostSpecs,
  supervisor,
  get running(): ProcessInfo | null {
    return hostRunning;
  },
  exited() {
    hostRunning = null;
  },
  plantLeftover(info?: ProcessInfo) {
    hostRunning = info ?? {
      id: "native-orphan-99",
      name: "server-leftover",
      pid: 99,
      status: "running",
    };
  },
  reset() {
    hostCalls.length = 0;
    hostSpecs.length = 0;
    hostRunning = null;
    hostSeq = 0;
  },
};

const temps: Array<{ root: string; sqlite: Database.Database }> = [];
export const udpSockets: dgram.Socket[] = [];

export function writeFactorioShapedSkill(skillsRoot: string): void {
  const skillDir = path.join(skillsRoot, "fixtures", "lab-factorio-ports");
  fs.mkdirSync(path.join(skillDir, "guides"), { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "metadata.yaml"),
    [
      "name: fixtures.lab-factorio-ports",
      "version: 0.1.0",
      "game: Factorio",
      "containerSupport: full",
      "dockerImage: factoriotools/factorio:stable",
      "adminDialect: none",
      "queryDialect: factorio",
      "ports:",
      "  - name: game",
      "    protocol: udp",
      "    default: 34197",
      "  - name: rcon",
      "    protocol: tcp",
      "    default: 27015",
      "healthChecks: []",
      "dependencies: []",
      "requiredTools: []",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(skillDir, "guides", "INSTALL.md"), "# Factorio ports fixture\n");
}

export function writePzSkill(skillsRoot: string): void {
  const skillDir = path.join(skillsRoot, "games", "project-zomboid");
  fs.mkdirSync(path.join(skillDir, "guides"), { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "metadata.yaml"),
    [
      "name: games.project-zomboid",
      "version: 0.1.0",
      "game: Project Zomboid",
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

export function writePzIni(dataPath: string, name: string, defaultPort: number): void {
  const dir = path.join(dataPath, "home", "Zomboid", "Server");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.ini`),
    [`DefaultPort=${defaultPort}`, `UDPPort=${defaultPort + 1}`, `PublicName=${name}`, ""].join(
      "\n",
    ),
  );
}

export function bindUdp(port = 0): Promise<{ socket: dgram.Socket; port: number }> {
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
      udpSockets.push(socket);
      resolve({ socket, port: addr.port });
    });
  });
}

function findRepoRoot(): string {
  let dir = path.resolve(process.cwd());
  while (true) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

export function tempEnv(): { db: Db; config: AppConfig; servers: ServerService } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-runtime-handle-"));
  const dbPath = path.join(root, "playon.db");
  applyBootstrap(dbPath);
  const config: AppConfig = {
    port: 0,
    dataRoot: root,
    dbPath,
    sessionSecret: "test",
    llmMode: "openai_compatible",
    runtimeMode: "docker",
    advertiseHost: "127.0.0.1",
    skillsRoots: [resolveFixturesRoot(findRepoRoot()), path.join(root, "skills")],
  };
  const { db, sqlite } = createDb(dbPath);
  temps.push({ root, sqlite });
  return { db, config, servers: new ServerService(db, config) };
}

export async function placeOnRemoteNode(db: Db, serverId: string): Promise<void> {
  await db.insert(nodesTable).values({
    id: REMOTE_NODE_ID,
    name: "lab-node",
    os: "linux",
    docker: true,
    native: true,
    steamcmd: false,
    lastSeenAt: new Date(),
    kind: "lan",
  });
  await db
    .update(serversTable)
    .set({ nodeId: REMOTE_NODE_ID })
    .where(eq(serversTable.id, serverId));
}

export async function nativeServer(opts?: { startable?: boolean }): Promise<{
  db: Db;
  config: AppConfig;
  servers: ServerService;
  id: string;
  gameDir: string;
  dataPath: string;
}> {
  const { db, config, servers } = tempEnv();
  const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });
  await db
    .update(serversTable)
    .set({ runtimeMode: "native" })
    .where(eq(serversTable.id, server.id));
  const gameDir = path.join(server.dataPath, "game");
  fs.mkdirSync(gameDir, { recursive: true });
  if (opts?.startable !== false) {
    fs.writeFileSync(path.join(gameDir, "start.sh"), "#!/bin/bash\nsleep 30\n");
    fs.writeFileSync(path.join(gameDir, "start.bat"), "@echo off\n");
  }
  fake.reset();
  host.reset();
  return { db, config, servers, id: server.id, gameDir, dataPath: server.dataPath };
}

export async function pzNativeServer(opts: { defaultPort: number }): Promise<{
  db: Db;
  config: AppConfig;
  servers: ServerService;
  id: string;
  gameDir: string;
}> {
  const { db, config, servers } = tempEnv();
  writePzSkill(path.join(config.dataRoot!, "skills"));
  const server = await servers.createFromSkill({
    skillName: "games.project-zomboid",
    serverName: "Hub",
  });
  writePzIni(server.dataPath, "Hub", opts.defaultPort);
  const gameDir = path.join(server.dataPath, "game");
  fs.mkdirSync(gameDir, { recursive: true });
  fs.writeFileSync(path.join(gameDir, "start.sh"), "#!/bin/bash\nsleep 30\n");
  fs.writeFileSync(path.join(gameDir, "start.bat"), "@echo off\n");
  fake.reset();
  host.reset();
  return { db, config, servers, id: server.id, gameDir };
}

export async function remoteServer(): Promise<{
  db: Db;
  servers: ServerService;
  id: string;
  name: string;
}> {
  const { db, servers } = tempEnv();
  const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });
  await placeOnRemoteNode(db, server.id);
  node.jobs.length = 0;
  return { db, servers, id: server.id, name: `playon-${server.id}` };
}

export async function remoteNativeServer(): Promise<{
  db: Db;
  config: AppConfig;
  servers: ServerService;
  id: string;
  procName: string;
  cwd: string;
}> {
  const { db, config, servers } = tempEnv();
  const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });
  await db
    .update(serversTable)
    .set({ runtimeMode: "native" })
    .where(eq(serversTable.id, server.id));
  await placeOnRemoteNode(db, server.id);
  node.jobs.length = 0;
  host.reset();
  fake.reset();
  return {
    db,
    config,
    servers,
    id: server.id,
    procName: `server-${server.id}`,
    cwd: `servers/${server.id}/game`,
  };
}

export function resetRuntimeHandleFakes(): void {
  fake.reset();
  node.reset();
  host.reset();
}

export function cleanupRuntimeHandleTemps(): void {
  while (udpSockets.length) {
    const socket = udpSockets.pop();
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
  }
  for (const entry of temps.splice(0)) {
    entry.sqlite.close();
    fs.rmSync(entry.root, { recursive: true, force: true });
  }
}
