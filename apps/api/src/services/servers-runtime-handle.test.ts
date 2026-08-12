import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import type {
  ContainerSpec,
  DockerAdapter,
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

const REMOTE_NODE_ID = "node-remote";

type FakeContainer = { id: string; name: string; status: "created" | "running" | "exited" };

const fake = vi.hoisted(() => {
  const calls: string[] = [];
  const containers = new Map<string, FakeContainer>();
  const specs: ContainerSpec[] = [];
  return {
    calls,
    containers,
    specs,
    reset() {
      calls.length = 0;
      containers.clear();
      specs.length = 0;
    },
    docker: {
      async create(spec: ContainerSpec) {
        calls.push(`create:${spec.name}`);
        specs.push(spec);
        const info: FakeContainer = { id: `cid-${spec.name}`, name: spec.name, status: "created" };
        containers.set(spec.name, info);
        return info;
      },
      async start(id: string) {
        calls.push(`start:${id}`);
        for (const c of containers.values()) if (c.id === id) c.status = "running";
      },
      async stop(id: string) {
        calls.push(`stop:${id}`);
        for (const c of containers.values()) if (c.id === id) c.status = "exited";
      },
      async remove(id: string) {
        calls.push(`remove:${id}`);
      },
      async inspect(id: string) {
        calls.push(`inspect:${id}`);
        const hit = containers.get(id) ?? [...containers.values()].find((c) => c.id === id);
        if (!hit) throw new Error("no such container");
        return hit;
      },
      async logs(id: string, tail?: number) {
        calls.push(`logs:${id}:${tail ?? "all"}`);
        return ["fake-log"];
      },
      async followLogs(id: string, _onLine: (line: string) => void) {
        calls.push(`follow:${id}`);
        return { abort: () => calls.push(`follow-abort:${id}`) };
      },
      async writeStdin(id: string, data: string) {
        calls.push(`stdin:${id}:${data}`);
      },
    },
  };
});

/**
 * Stands in for a node-agent: it only speaks the node job contract, and it
 * validates args and results on both shores exactly as the real seam does.
 */
const node = vi.hoisted(() => {
  type Container = { id: string; name: string; status: "created" | "running" | "exited" };
  type Process = { id: string; name: string; pid?: number; status: "running" | "stopped" };
  const jobs: Array<{ kind: string; args: Record<string, unknown> }> = [];
  const containers = new Map<string, Container>();
  /** Keyed by supervisor name, because identity is all the node is ever given. */
  const processes = new Map<string, Process>();
  /** The node's own disk, keyed by jail-relative path. */
  const files = new Map<string, string>();
  let seq = 0;
  return {
    jobs,
    containers,
    processes,
    files,
    kinds(): string[] {
      return jobs.map((j) => j.kind);
    },
    reset() {
      jobs.length = 0;
      containers.clear();
      processes.clear();
      files.clear();
      seq = 0;
    },
    async dispatch(opts: { kind: string; args?: Record<string, unknown> }): Promise<unknown> {
      const { parseNodeJobArgs, parseNodeJobResult } = await import("@playon/shared");
      const kind = opts.kind as NodeJobKind;
      const args = parseNodeJobArgs(kind, opts.args ?? {}) as Record<string, unknown>;
      jobs.push({ kind, args });
      const id = String(args.id ?? "");
      const found = containers.get(id) ?? [...containers.values()].find((c) => c.id === id);
      const result = ((): unknown => {
        switch (kind) {
          case "fs_ensure_dir":
            return { path: args.path, ok: true };
          case "fs_write_text":
            return { path: args.path, bytes: String(args.content ?? "").length };
          case "fs_read_text": {
            const rel = String(args.path);
            const bytes = Buffer.from(files.get(rel) ?? "", "utf8");
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
            const created: Container = { id: `cid-${name}`, name, status: "created" };
            containers.set(name, created);
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
            // The node answers for an identity it cannot find too — just not "running".
            return processes.get(name) ?? { id: name, name, status: "stopped" };
          }
          case "process_start": {
            const name = String(args.name);
            const started: Process = {
              id: `native-${name}-${++seq}`,
              name,
              pid: 4200 + seq,
              status: "running",
            };
            processes.set(name, started);
            return started;
          }
          case "process_stop":
            processes.delete(String(args.name ?? ""));
            return { ok: true };
          default:
            throw new Error(`unexpected_job_kind_in_test: ${kind}`);
        }
      })();
      return parseNodeJobResult(kind, result);
    },
  };
});

vi.mock("./node-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./node-runtime.js")>();
  return {
    ...actual,
    dispatchNodeJob: (opts: { kind: string; args?: Record<string, unknown> }) =>
      node.dispatch(opts),
  };
});

vi.mock("./node-sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./node-sync.js")>();
  return { ...actual, pushServerDirToNode: async () => undefined };
});

/**
 * Stands in for the host's process supervisor. It only answers by identity
 * (name + cwd), so nothing in the control plane can lean on a stored process id.
 */
const host = vi.hoisted(() => {
  const calls: string[] = [];
  const specs: ProcessSpec[] = [];
  let running: ProcessInfo | null = null;
  let seq = 0;
  const supervisor: ProcessSupervisor = {
    async start(spec) {
      calls.push(`start:${spec.name}:${spec.cwd}`);
      specs.push(spec);
      running = { id: `native-${spec.name}-${++seq}`, name: spec.name, pid: 4200 + seq, status: "running" };
      return running;
    },
    async stop(id) {
      calls.push(`stop:${id}`);
      running = null;
    },
    async status(id) {
      return running?.id === id ? running : { id, name: id, status: "stopped" as const };
    },
    async find(name, cwd) {
      calls.push(`find:${name}:${cwd}`);
      return running;
    },
    async reclaim(name, cwd) {
      calls.push(`reclaim:${name}:${cwd}`);
      running = null;
    },
    async writeStdin(name, cwd, data) {
      calls.push(`stdin:${name}:${cwd}:${data}`);
    },
  };
  return {
    calls,
    specs,
    supervisor,
    get running(): ProcessInfo | null {
      return running;
    },
    exited() {
      running = null;
    },
    reset() {
      calls.length = 0;
      specs.length = 0;
      running = null;
      seq = 0;
    },
  };
});

vi.mock("@playon/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@playon/runtime")>();
  return {
    ...actual,
    // Same as setup-unit: createFromSkill needs Local docker-eligible; FakeDocker
    // stands in for the daemon. This file's mock replaces the setup mock entirely.
    probeHostCapabilities: (dataRoot: string, env?: NodeJS.ProcessEnv) => {
      const real = actual.probeHostCapabilities(dataRoot, env);
      return { ...real, docker: true };
    },
    createRuntime: async () => ({
      docker: fake.docker as unknown as DockerAdapter,
      process: host.supervisor,
      mode: "docker" as const,
    }),
  };
});

const temps: Array<{ root: string; sqlite: Database.Database }> = [];

function findRepoRoot(): string {
  let dir = path.resolve(process.cwd());
  while (true) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

function tempEnv(): { db: Db; config: AppConfig; servers: ServerService } {
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

/** Move a server onto a remote docker node the way placement would. */
async function placeOnRemoteNode(db: Db, serverId: string): Promise<void> {
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

/** A native server on this host with a startable game dir. */
async function nativeServer(opts?: { startable?: boolean }): Promise<{
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
    // resolveNativeLaunch only launches what exists on disk, on either platform.
    fs.writeFileSync(path.join(gameDir, "start.sh"), "#!/bin/bash\nsleep 30\n");
    fs.writeFileSync(path.join(gameDir, "start.bat"), "@echo off\n");
  }
  fake.reset();
  host.reset();
  return { db, config, servers, id: server.id, gameDir, dataPath: server.dataPath };
}

/** A docker server whose container only exists on a node. */
async function remoteServer(): Promise<{
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

/** A native server whose game dir only exists on the node. */
async function remoteNativeServer(): Promise<{
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

beforeEach(() => {
  fake.reset();
  node.reset();
  host.reset();
});

afterEach(() => {
  for (const entry of temps.splice(0)) {
    entry.sqlite.close();
    fs.rmSync(entry.root, { recursive: true, force: true });
  }
});

describe("local docker lifecycle through ServerRuntimeHandle", () => {
  it("exposes a docker/local handle from the runtime choke point", async () => {
    const { servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });

    const handle = await servers.runtime(server.id);

    expect(handle.mode).toBe("docker");
    expect(handle.locality).toBe("local");
  });

  it("start creates the container under the handle-owned name and starts it", async () => {
    const { servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });

    const started = await servers.start(server.id);

    expect(started.status).toBe("running");
    expect(fake.calls).toContain(`create:playon-${server.id}`);
    expect(fake.calls).toContain(`start:cid-playon-${server.id}`);

    const spec = fake.specs[0]!;
    expect(spec.image).toBe("itzg/minecraft-server:latest");
    expect(spec.env?.RCON_PORT).toBe("25575");
    expect(spec.ports?.map((p) => p.host)).toEqual([25565, 25575]);
    expect(spec.binds?.[0]).toEqual({
      hostPath: path.join(server.dataPath, "game"),
      containerPath: "/data",
    });
  });

  it("start reuses an existing container instead of creating a second one", async () => {
    const { servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });
    await servers.start(server.id);
    await servers.stop(server.id);
    fake.calls.length = 0;

    await servers.start(server.id);

    expect(fake.calls.filter((c) => c.startsWith("create:"))).toEqual([]);
    expect(fake.calls).toContain(`start:cid-playon-${server.id}`);
  });

  it("stop resolves the container id before stopping it", async () => {
    const { servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });
    await servers.start(server.id);
    fake.calls.length = 0;

    const stopped = await servers.stop(server.id);

    expect(stopped.status).toBe("stopped");
    expect(fake.calls).toContain(`stop:cid-playon-${server.id}`);
    expect(fake.calls).not.toContain(`stop:playon-${server.id}`);
  });

  it("restart cycles the same container through the handle", async () => {
    const { servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });
    await servers.start(server.id);
    fake.calls.length = 0;

    const restarted = await servers.restart(server.id);

    expect(restarted.status).toBe("running");
    expect(fake.calls).toEqual(
      expect.arrayContaining([`stop:cid-playon-${server.id}`, `start:cid-playon-${server.id}`]),
    );
    expect(fake.calls.filter((c) => c.startsWith("create:"))).toEqual([]);
  });

  it("status reconciliation follows the container state", async () => {
    const { servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });
    await servers.start(server.id);

    fake.containers.get(`playon-${server.id}`)!.status = "exited";
    expect((await servers.get(server.id))!.status).toBe("stopped");

    fake.containers.get(`playon-${server.id}`)!.status = "running";
    expect((await servers.get(server.id))!.status).toBe("running");
  });

  it("status reconciliation reports stopped when the container is gone", async () => {
    const { servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });
    await servers.start(server.id);

    fake.containers.clear();

    expect((await servers.get(server.id))!.status).toBe("stopped");
  });
});

describe("local native lifecycle through ServerRuntimeHandle", () => {
  const startScript = process.platform === "win32" ? "start.bat" : "start.sh";

  it("exposes a native/local handle from the runtime choke point", async () => {
    const { servers, id } = await nativeServer();

    const handle = await servers.runtime(id);

    expect(handle.mode).toBe("native");
    expect(handle.locality).toBe("local");
  });

  it("start launches the resolved process under the handle-owned identity", async () => {
    const { servers, id, gameDir, dataPath } = await nativeServer();

    const started = await servers.start(id);

    expect(started.status).toBe("running");
    expect(host.calls).toEqual([`find:server-${id}:${gameDir}`, `start:server-${id}:${gameDir}`]);
    const spec = host.specs[0]!;
    expect(spec.args?.join(" ")).toContain(startScript);
    expect(spec.env?.PLAYON_SERVER_ID).toBe(id);
    expect(spec.logFile).toBe(path.join(dataPath, "logs", "console.log"));
    // A native server never touches the container path.
    expect(fake.calls).toEqual([]);
  });

  it("passes PLAYON_MANAGED_FROM to the process env when skill marker has managedFrom", async () => {
    const { servers, id } = await nativeServer();
    const { writeSkillMarker, readSkillMarker } = await import("./skill-marker.js");
    const server = (await servers.get(id))!;
    const marker = readSkillMarker(server.dataPath);
    if (!marker) throw new Error("skill marker missing");
    // Simulate a managed server by adding managedFrom to the skill marker.
    writeSkillMarker(server.dataPath, { ...marker, managedFrom: "/opt/pzserver" } as never);

    const started = await servers.start(id);

    expect(started.status).toBe("running");
    const spec = host.specs[0]!;
    expect(spec.env?.PLAYON_SERVER_ID).toBe(id);
    expect(spec.env?.PLAYON_MANAGED_FROM).toBe("/opt/pzserver");
  });

  it("start refuses a game dir with nothing to launch, and reports the error", async () => {
    const { servers, id } = await nativeServer({ startable: false });

    await expect(servers.start(id)).rejects.toThrow(/native_binaries_missing/);
    expect(host.specs).toEqual([]);
    // Nothing was launched, so the next re-resolve answers stopped over the error flag.
    expect((await servers.get(id))!.status).toBe("stopped");
  });

  it("start stops a process it re-resolved instead of stacking a second one", async () => {
    const { servers, id, gameDir } = await nativeServer();
    await servers.start(id);
    host.calls.length = 0;

    await servers.start(id);

    expect(host.calls).toEqual([
      `find:server-${id}:${gameDir}`,
      `reclaim:server-${id}:${gameDir}`,
      `start:server-${id}:${gameDir}`,
    ]);
    expect(host.specs).toHaveLength(2);
  });

  it("stop reclaims by identity, never by a stored process id", async () => {
    const { servers, id, gameDir } = await nativeServer();
    await servers.start(id);
    host.calls.length = 0;

    const stopped = await servers.stop(id);

    expect(stopped.status).toBe("stopped");
    expect(host.calls).toEqual([`find:server-${id}:${gameDir}`, `reclaim:server-${id}:${gameDir}`]);
    expect(host.calls.some((c) => c.startsWith("stop:"))).toBe(false);
    expect(host.running).toBeNull();
  });

  it("stop is mode-correct on Home native: no docker dual-fire after handle.stop", async () => {
    const { servers, id } = await nativeServer();
    await servers.start(id);
    fake.calls.length = 0;

    await servers.stop(id);

    expect(fake.calls).toEqual([]);
  });

  it("restart cycles the same identity", async () => {
    const { servers, id, gameDir } = await nativeServer();
    await servers.start(id);
    host.calls.length = 0;

    const restarted = await servers.restart(id);

    expect(restarted.status).toBe("running");
    expect(host.calls).toEqual([
      `find:server-${id}:${gameDir}`,
      `reclaim:server-${id}:${gameDir}`,
      `find:server-${id}:${gameDir}`,
      `start:server-${id}:${gameDir}`,
    ]);
  });

  it("status reconciliation follows the process, not a remembered id", async () => {
    const { servers, id } = await nativeServer();
    await servers.start(id);

    expect((await servers.get(id))!.status).toBe("running");

    host.exited();
    expect((await servers.get(id))!.status).toBe("stopped");
  });

  it("a fresh control plane re-resolves the running process from identity", async () => {
    const { db, config, servers, id } = await nativeServer();
    await servers.start(id);

    // No durable process map: a new service must still see the running server.
    const reborn = new ServerService(db, config);
    expect((await reborn.get(id))!.status).toBe("running");
  });
});

describe("remote docker lifecycle through ServerRuntimeHandle", () => {
  it("exposes a docker/remote handle from the runtime choke point", async () => {
    const { servers, id } = await remoteServer();

    const handle = await servers.runtime(id);

    expect(handle.mode).toBe("docker");
    expect(handle.locality).toBe("remote");
  });

  it("start creates and starts the container on the node, never on the Home docker", async () => {
    const { servers, id, name } = await remoteServer();

    const started = await servers.start(id);

    expect(started.status).toBe("running");
    expect(node.kinds()).toContain("container_create");
    expect(node.kinds()).toContain("container_start");
    // Home's docker adapter must stay out of a remote server's lifecycle.
    expect(fake.calls).toEqual([]);

    const create = node.jobs.find((j) => j.kind === "container_create")!;
    expect(create.args.name).toBe(name);
    expect(create.args.image).toBe("itzg/minecraft-server:latest");
    // Host paths are jail-relative so the node resolves them under its own data root.
    expect(create.args.binds).toEqual([
      { hostPath: `servers/${id}/game`, containerPath: "/data" },
    ]);
    expect((create.args.env as Record<string, string>).RCON_PORT).toBe("25575");

    expect(node.jobs.find((j) => j.kind === "container_start")!.args).toEqual({
      id: `cid-${name}`,
      serverId: id,
    });
  });

  it("start re-resolves an existing container by name instead of creating another", async () => {
    const { servers, id, name } = await remoteServer();
    await servers.start(id);
    await servers.stop(id);
    node.jobs.length = 0;

    await servers.start(id);

    expect(node.kinds()).not.toContain("container_create");
    expect(node.jobs.find((j) => j.kind === "container_start")!.args.id).toBe(`cid-${name}`);
  });

  it("stop is mode-correct: the resolved container only, no process_stop", async () => {
    const { servers, id, name } = await remoteServer();
    await servers.start(id);
    node.jobs.length = 0;

    const stopped = await servers.stop(id);

    expect(stopped.status).toBe("stopped");
    expect(node.kinds()).toEqual(["container_inspect", "container_stop"]);
    expect(node.jobs.at(-1)!.args).toEqual({ id: `cid-${name}`, serverId: id });
  });

  it("restart cycles the same container on the node", async () => {
    const { servers, id, name } = await remoteServer();
    await servers.start(id);
    node.jobs.length = 0;

    const restarted = await servers.restart(id);

    expect(restarted.status).toBe("running");
    expect(node.kinds()).not.toContain("container_create");
    expect(node.kinds()).toContain("container_stop");
    expect(node.jobs.at(-1)).toMatchObject({
      kind: "container_start",
      args: { id: `cid-${name}` },
    });
  });

  it("status reconciliation follows the node's container, not Home's", async () => {
    const { servers, id, name } = await remoteServer();
    await servers.start(id);

    node.containers.get(name)!.status = "exited";
    expect((await servers.get(id))!.status).toBe("stopped");

    node.containers.get(name)!.status = "running";
    expect((await servers.get(id))!.status).toBe("running");

    node.containers.clear();
    expect((await servers.get(id))!.status).toBe("stopped");
    expect(fake.calls).toEqual([]);
  });

  it("does not question an offline node, and does not read its silence as stopped", async () => {
    const { db, servers, id } = await remoteServer();
    await servers.start(id);
    node.jobs.length = 0;
    await db
      .update(nodesTable)
      .set({ lastSeenAt: new Date(Date.now() - 3_600_000) })
      .where(eq(nodesTable.id, REMOTE_NODE_ID));

    expect((await servers.get(id))!.status).toBe("running");
    expect(node.jobs).toEqual([]);
  });
});

describe("remote native lifecycle through ServerRuntimeHandle", () => {
  const processKinds = (): string[] => node.kinds().filter((k) => k.startsWith("process_"));

  it("exposes a native/remote handle from the runtime choke point", async () => {
    const { servers, id } = await remoteNativeServer();

    const handle = await servers.runtime(id);

    expect(handle.mode).toBe("native");
    expect(handle.locality).toBe("remote");
  });

  it("starts the process on the node, never on Home's supervisor or docker", async () => {
    const { servers, id, procName, cwd } = await remoteNativeServer();

    const started = await servers.start(id);

    expect(started.status).toBe("running");
    expect(processKinds()).toEqual(["process_status", "process_start"]);
    // Home runs neither the process nor a container for a server it does not host.
    expect(host.calls).toEqual([]);
    expect(fake.calls).toEqual([]);

    expect(node.jobs.find((j) => j.kind === "process_start")!.args).toEqual({
      name: procName,
      command: "/bin/bash",
      args: ["start.sh"],
      cwd,
      env: { PLAYON_SERVER_ID: id },
      serverId: id,
      // keepStdin omitted when false — older agents reject unrecognized keys.
      // Jail-relative, so the node writes the console under its own data root.
      logRel: `servers/${id}/logs/console.log`,
    });
  });

  it("passes PLAYON_MANAGED_FROM to the process env when skill marker has managedFrom", async () => {
    const { servers, id, procName, cwd } = await remoteNativeServer();
    const { writeSkillMarker, readSkillMarker } = await import("./skill-marker.js");
    const server = (await servers.get(id))!;
    const marker = readSkillMarker(server.dataPath);
    if (!marker) throw new Error("skill marker missing");
    // Simulate a managed server by adding managedFrom to the skill marker.
    writeSkillMarker(server.dataPath, { ...marker, managedFrom: "/opt/pzserver" } as never);

    const started = await servers.start(id);

    expect(started.status).toBe("running");
    const startArgs = node.jobs.find((j) => j.kind === "process_start")!.args;
    expect(startArgs).toEqual({
      name: procName,
      command: "/bin/bash",
      args: ["start.sh"],
      cwd,
      env: { PLAYON_SERVER_ID: id, PLAYON_MANAGED_FROM: "/opt/pzserver" },
      serverId: id,
      logRel: `servers/${id}/logs/console.log`,
    });
  });

  it("re-resolves the node's process on start instead of stacking a second one", async () => {
    const { servers, id, procName, cwd } = await remoteNativeServer();
    await servers.start(id);
    node.jobs.length = 0;

    await servers.start(id);

    expect(processKinds()).toEqual(["process_status", "process_stop", "process_start"]);
    expect(node.jobs.find((j) => j.kind === "process_stop")!.args).toEqual({
      id: `native-${procName}-1`,
      name: procName,
      cwd,
      serverId: id,
    });
  });

  it("stop is mode-correct: the node's process only, no container_stop", async () => {
    const { servers, id, procName, cwd } = await remoteNativeServer();
    await servers.start(id);
    node.jobs.length = 0;

    const stopped = await servers.stop(id);

    expect(stopped.status).toBe("stopped");
    expect(node.kinds()).toEqual(["process_status", "process_stop"]);
    expect(node.jobs.at(-1)!.args).toEqual({
      id: `native-${procName}-1`,
      name: procName,
      cwd,
      serverId: id,
    });
    expect(fake.calls).toEqual([]);
  });

  it("restart cycles the same identity on the node", async () => {
    const { servers, id } = await remoteNativeServer();
    await servers.start(id);
    node.jobs.length = 0;

    const restarted = await servers.restart(id);

    expect(restarted.status).toBe("running");
    expect(processKinds()).toEqual([
      "process_status",
      "process_stop",
      "process_status",
      "process_start",
    ]);
  });

  it("status reconciliation follows the node's process, by identity", async () => {
    const { servers, id, procName, cwd } = await remoteNativeServer();
    await servers.start(id);
    node.jobs.length = 0;

    expect((await servers.get(id))!.status).toBe("running");
    expect(node.jobs.at(-1)).toEqual({ kind: "process_status", args: { name: procName, cwd } });

    // The game exits on the node; Home learns it from the next re-resolve.
    node.processes.clear();
    expect((await servers.get(id))!.status).toBe("stopped");
  });

  it("a fresh control plane re-resolves the node's process from identity alone", async () => {
    const { db, config, servers, id } = await remoteNativeServer();
    await servers.start(id);

    // No durable process map survives a restart, and none is needed.
    const reborn = new ServerService(db, config);
    expect((await reborn.get(id))!.status).toBe("running");
  });

  it("does not question an offline node, and does not read its silence as stopped", async () => {
    const { db, servers, id } = await remoteNativeServer();
    await servers.start(id);
    node.jobs.length = 0;
    await db
      .update(nodesTable)
      .set({ lastSeenAt: new Date(Date.now() - 3_600_000) })
      .where(eq(nodesTable.id, REMOTE_NODE_ID));

    expect((await servers.get(id))!.status).toBe("running");
    expect(node.jobs).toEqual([]);
  });
});

describe("logs through ServerRuntimeHandle", () => {
  /** Write the console file a native server's runtime tails on this host. */
  function writeLocalConsole(dataPath: string, text: string): void {
    const file = path.join(dataPath, "logs", "console.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }

  it("local docker: tails the container Home runs", async () => {
    const { servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });
    await servers.start(server.id);
    fake.calls.length = 0;

    const tail = await servers.tailLogs(server.id, 25);

    expect(tail).toEqual({ status: "running", runtime: "docker", lines: ["fake-log"] });
    expect(fake.calls).toContain(`logs:cid-playon-${server.id}:25`);
  });

  it("local docker: start follows logs through the handle, stop aborts", async () => {
    const { servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });
    fake.calls.length = 0;

    await servers.start(server.id);
    expect(fake.calls).toContain(`follow:cid-playon-${server.id}`);

    await servers.stop(server.id);
    expect(fake.calls).toContain(`follow-abort:cid-playon-${server.id}`);
  });

  it("remote docker: tails the node's container, never Home's docker", async () => {
    const { servers, id, name } = await remoteServer();
    await servers.start(id);
    node.jobs.length = 0;
    fake.calls.length = 0;

    const tail = await servers.tailLogs(id, 25);

    expect(tail).toEqual({
      status: "running",
      runtime: "docker",
      lines: ["node-log-1", "node-log-2"],
    });
    expect(node.jobs.at(-1)).toEqual({
      kind: "container_logs",
      args: { id: `cid-${name}`, tail: 25 },
    });
    // The old Home-docker-only path would have tailed the wrong host entirely.
    expect(fake.calls).toEqual([]);
  });

  it("local native: tails the console file the process writes", async () => {
    const { servers, id, dataPath } = await nativeServer();
    writeLocalConsole(dataPath, "boot\nready\nplayer joined\n");

    const tail = await servers.tailLogs(id, 2);

    expect(tail).toEqual({
      status: "stopped",
      runtime: "native",
      lines: ["ready", "player joined"],
    });
  });

  it("remote native: tails the node's console file over the fs job contract", async () => {
    const { servers, id } = await remoteNativeServer();
    node.files.set(`servers/${id}/logs/console.log`, "boot\nready\nplayer joined\n");
    node.jobs.length = 0;

    const tail = await servers.tailLogs(id, 2);

    expect(tail).toEqual({
      status: "stopped",
      runtime: "native",
      lines: ["ready", "player joined"],
    });
    expect(node.kinds().filter((k) => k === "fs_read_text")).toHaveLength(2);
    // Home neither runs nor reads for a server it does not host.
    expect(host.calls).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("a runtime that cannot answer tails nothing rather than failing the read", async () => {
    const { db, servers, id } = await remoteServer();
    await db
      .update(nodesTable)
      .set({ lastSeenAt: new Date(Date.now() - 3_600_000) })
      .where(eq(nodesTable.id, REMOTE_NODE_ID));
    node.containers.clear();

    const tail = await servers.tailLogs(id, 25);

    expect(tail).toMatchObject({ runtime: "docker", lines: [] });
  });

  it("detail carries the node's container status and logs, not Home's", async () => {
    const { servers, id, name } = await remoteServer();
    await servers.start(id);
    fake.calls.length = 0;

    const detail = await servers.detail(id);

    expect(detail!.runtime).toMatchObject({
      kind: "docker",
      containerName: name,
      containerStatus: "running",
      logs: ["node-log-1", "node-log-2"],
    });
    expect(fake.calls).toEqual([]);
  });

  it("detail carries a native server's console tail", async () => {
    const { servers, id, dataPath } = await nativeServer();
    writeLocalConsole(dataPath, "boot\nready\n");

    const detail = await servers.detail(id);

    expect(detail!.runtime.kind).toBe("native");
    expect(detail!.runtime.logs).toEqual(["boot", "ready"]);
  });
});

describe("console stdin through ServerRuntimeHandle", () => {
  const STDIN_SKILL = "fixtures.stdin-console-server";

  /** A skill whose admin console is the game's own stdin, in the per-test skills root. */
  function writeStdinSkill(config: AppConfig): void {
    const dir = path.join(config.dataRoot, "skills", "stdin-console-server");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "metadata.yaml"),
      [
        `name: ${STDIN_SKILL}`,
        "version: 0.1.0",
        "game: Stdin Console Server",
        "containerSupport: full",
        "dockerImage: playon/fixture-stdin:latest",
        "dockerDataMount: /data",
        "adminDialect: stdin",
        "ports:",
        "  - name: game",
        "    protocol: tcp",
        "    default: 27015",
        "",
      ].join("\n"),
    );
  }

  /** A stdin-dialect server in one of the four quadrants. */
  async function stdinServer(opts?: { remote?: boolean; native?: boolean }): Promise<{
    servers: ServerService;
    id: string;
    name: string;
    gameDir: string;
  }> {
    const { db, config, servers } = tempEnv();
    writeStdinSkill(config);
    const server = await servers.createFromSkill({ skillName: STDIN_SKILL });
    const gameDir = path.join(server.dataPath, "game");
    if (opts?.native) {
      await db
        .update(serversTable)
        .set({ runtimeMode: "native" })
        .where(eq(serversTable.id, server.id));
      fs.mkdirSync(gameDir, { recursive: true });
      fs.writeFileSync(path.join(gameDir, "start.sh"), "#!/bin/bash\nsleep 30\n");
      fs.writeFileSync(path.join(gameDir, "start.bat"), "@echo off\n");
    }
    if (opts?.remote) await placeOnRemoteNode(db, server.id);
    fake.reset();
    host.reset();
    node.jobs.length = 0;
    return { servers, id: server.id, name: `playon-${server.id}`, gameDir };
  }

  it("local docker: writes to the container Home runs, by resolved id", async () => {
    const { servers, id } = await stdinServer();
    await servers.start(id);
    fake.calls.length = 0;

    await expect(servers.consoleCapability(id)).resolves.toEqual({
      input: "ready",
      dialect: "stdin",
    });
    await servers.writeStdin(id, "say hi");

    expect(fake.calls).toContain(`stdin:cid-playon-${id}:say hi`);
  });

  it("reports the console unavailable while the server is down", async () => {
    const { servers, id } = await stdinServer();

    await expect(servers.consoleCapability(id)).resolves.toEqual({
      input: "unavailable",
      dialect: "stdin",
    });
  });

  it("remote docker: writes through the node's container job, never Home's docker", async () => {
    const { servers, id, name } = await stdinServer({ remote: true });
    await servers.start(id);
    node.jobs.length = 0;
    fake.calls.length = 0;

    await servers.writeStdin(id, "say hi");

    expect(node.jobs.at(-1)).toEqual({
      kind: "container_stdin",
      args: { id: `cid-${name}`, line: "say hi" },
    });
    expect(fake.calls).toEqual([]);
  });

  it("local native: writes to the supervised process, by identity", async () => {
    const { servers, id, gameDir } = await stdinServer({ native: true });
    await servers.start(id);
    host.calls.length = 0;
    fake.calls.length = 0;

    await expect(servers.consoleCapability(id)).resolves.toEqual({
      input: "ready",
      dialect: "stdin",
    });
    await servers.writeStdin(id, "say hi");

    expect(host.calls).toContain(`stdin:server-${id}:${gameDir}:say hi`);
    // A native console never goes near the container path.
    expect(fake.calls).toEqual([]);
  });

  it("remote native: reports no console instead of pretending to write", async () => {
    const { servers, id } = await stdinServer({ remote: true, native: true });
    await servers.start(id);
    node.jobs.length = 0;

    await expect(servers.consoleCapability(id)).resolves.toEqual({
      input: "unsupported",
      dialect: "stdin",
    });
    await expect(servers.writeStdin(id, "say hi")).rejects.toThrow(
      /runtime_unsupported: native stdin over remote transport/,
    );
    expect(node.kinds()).not.toContain("container_stdin");
    expect(host.calls).toEqual([]);
  });
});
