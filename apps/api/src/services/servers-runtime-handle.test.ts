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
  let seq = 0;
  return {
    jobs,
    containers,
    processes,
    kinds(): string[] {
      return jobs.map((j) => j.kind);
    },
    reset() {
      jobs.length = 0;
      containers.clear();
      processes.clear();
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

  it("stop still fires the container path, so a mode flip cannot orphan a container", async () => {
    const { servers, id } = await nativeServer();
    await servers.start(id);
    fake.calls.length = 0;

    await servers.stop(id);

    expect(fake.calls).toEqual([`stop:playon-${id}`]);
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
      // Jail-relative, so the node writes the console under its own data root.
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
