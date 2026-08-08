import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  localDockerTransport,
  localNativeTransport,
  openServerRuntime,
  remoteDockerTransport,
  remoteNativeTransport,
  RuntimeUnsupportedError,
  type ContainerJobDispatch,
  type ContainerJobKind,
  type DockerRuntimeTransport,
  type NativeProcessIdentity,
  type NativeRuntimeTransport,
  type NodeTextReadDispatch,
  type ProcessJobDispatch,
  type ProcessJobKind,
  type ServerContainerSpec,
  type ServerProcessSpec,
} from "./server-runtime.js";
import type {
  ContainerInfo,
  ContainerSpec,
  DockerAdapter,
  ProcessInfo,
  ProcessSpec,
  ProcessSupervisor,
} from "./types.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-server-runtime-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const SPEC: ServerContainerSpec = {
  image: "playon/fixture:latest",
  env: { A: "1" },
  ports: [{ host: 25565, container: 25565, protocol: "tcp" }],
};

interface FakeDocker extends DockerRuntimeTransport {
  calls: string[];
  containers: Map<string, ContainerInfo>;
}

function fakeDockerTransport(opts?: {
  existing?: ContainerInfo;
  locality?: "local" | "remote";
  stdin?: boolean;
}): FakeDocker {
  const containers = new Map<string, ContainerInfo>();
  if (opts?.existing) containers.set(opts.existing.name, opts.existing);
  const calls: string[] = [];
  const transport: FakeDocker = {
    locality: opts?.locality ?? "local",
    calls,
    containers,
    async inspect(id) {
      calls.push(`inspect:${id}`);
      const hit = containers.get(id) ?? [...containers.values()].find((c) => c.id === id);
      if (!hit) throw new Error("no such container");
      return hit;
    },
    async create(spec: ContainerSpec) {
      calls.push(`create:${spec.name}:${spec.image}`);
      const info: ContainerInfo = { id: `id-${spec.name}`, name: spec.name, status: "created" };
      containers.set(spec.name, info);
      return info;
    },
    async start(id) {
      calls.push(`start:${id}`);
    },
    async stop(id) {
      calls.push(`stop:${id}`);
    },
    async logs(id, tail) {
      calls.push(`logs:${id}:${tail ?? "all"}`);
      return ["line-1"];
    },
    writeStdin: opts?.stdin === false
      ? undefined
      : async (id, line) => {
          calls.push(`stdin:${id}:${line}`);
        },
  };
  return transport;
}

function openDocker(transport: DockerRuntimeTransport) {
  return openServerRuntime(
    { serverId: "srv1", mode: "docker", locality: transport.locality },
    {
      containerName: "playon-srv1",
      docker: transport,
      resolveContainerSpec: async () => SPEC,
    },
  );
}

describe("docker ServerRuntimeHandle", () => {
  it("creates the container under the handle-owned name, then starts it", async () => {
    const transport = fakeDockerTransport();
    const handle = openDocker(transport);

    const started = await handle.start();

    expect(started.id).toBe("id-playon-srv1");
    expect(transport.calls).toEqual([
      "inspect:playon-srv1",
      "create:playon-srv1:playon/fixture:latest",
      "start:id-playon-srv1",
    ]);
  });

  it("re-resolves an existing container instead of creating a second one", async () => {
    const transport = fakeDockerTransport({
      existing: { id: "abc123", name: "playon-srv1", status: "exited" },
    });
    const handle = openDocker(transport);

    const started = await handle.start();

    expect(started.id).toBe("abc123");
    expect(transport.calls).toEqual(["inspect:playon-srv1", "start:abc123"]);
  });

  it("stops the resolved container id", async () => {
    const transport = fakeDockerTransport({
      existing: { id: "abc123", name: "playon-srv1", status: "running" },
    });
    const handle = openDocker(transport);

    await handle.stop();

    expect(transport.calls).toEqual(["inspect:playon-srv1", "stop:abc123"]);
  });

  it("stop is a no-op when the container is gone", async () => {
    const transport = fakeDockerTransport();
    const handle = openDocker(transport);

    await expect(handle.stop()).resolves.toBeUndefined();
    expect(transport.calls).toEqual(["inspect:playon-srv1"]);
  });

  it("restart stops before starting", async () => {
    const transport = fakeDockerTransport({
      existing: { id: "abc123", name: "playon-srv1", status: "running" },
    });
    const handle = openDocker(transport);

    await handle.restart();

    expect(transport.calls).toEqual([
      "inspect:playon-srv1",
      "stop:abc123",
      "inspect:playon-srv1",
      "start:abc123",
    ]);
  });

  it("maps container status onto runtime state", async () => {
    const running = openDocker(
      fakeDockerTransport({ existing: { id: "a", name: "playon-srv1", status: "running" } }),
    );
    const exited = openDocker(
      fakeDockerTransport({ existing: { id: "b", name: "playon-srv1", status: "exited" } }),
    );
    const missing = openDocker(fakeDockerTransport());

    await expect(running.status()).resolves.toEqual({ state: "running", id: "a", detail: "running" });
    await expect(exited.status()).resolves.toEqual({ state: "stopped", id: "b", detail: "exited" });
    await expect(missing.status()).resolves.toEqual({ state: "missing" });
  });

  it("tails logs for the resolved id and returns nothing when missing", async () => {
    const transport = fakeDockerTransport({
      existing: { id: "abc123", name: "playon-srv1", status: "running" },
    });
    await expect(openDocker(transport).logs(20)).resolves.toEqual(["line-1"]);
    expect(transport.calls).toContain("logs:abc123:20");

    await expect(openDocker(fakeDockerTransport()).logs(20)).resolves.toEqual([]);
  });

  it("writes stdin to the resolved id, and reports unsupported transports", async () => {
    const transport = fakeDockerTransport({
      existing: { id: "abc123", name: "playon-srv1", status: "running" },
    });
    await openDocker(transport).writeStdin("say hi");
    expect(transport.calls).toContain("stdin:abc123:say hi");

    const noStdin = fakeDockerTransport({
      existing: { id: "abc123", name: "playon-srv1", status: "running" },
      stdin: false,
    });
    await expect(openDocker(noStdin).writeStdin("say hi")).rejects.toThrow(
      /runtime_unsupported: docker stdin/,
    );
  });
});

describe("localDockerTransport", () => {
  it("adapts a DockerAdapter and reports local locality", async () => {
    const seen: string[] = [];
    const adapter: DockerAdapter = {
      async create(spec) {
        seen.push(`create:${spec.name}`);
        return { id: "x", name: spec.name, status: "created" };
      },
      async start(id) {
        seen.push(`start:${id}`);
      },
      async stop(id) {
        seen.push(`stop:${id}`);
      },
      async remove(id) {
        seen.push(`remove:${id}`);
      },
      async inspect(id) {
        seen.push(`inspect:${id}`);
        return { id: "x", name: id, status: "running" };
      },
      async logs(id, tail) {
        seen.push(`logs:${id}:${tail ?? "all"}`);
        return [];
      },
    };

    const transport = localDockerTransport(adapter);
    expect(transport.locality).toBe("local");
    // Adapters without stdin support surface as an unsupported capability, not a silent no-op.
    expect(transport.writeStdin).toBeUndefined();

    await openDocker(transport).start();
    expect(seen).toEqual(["inspect:playon-srv1", "start:x"]);
  });
});

interface FakeJob {
  kind: ContainerJobKind;
  args: Record<string, unknown>;
  timeoutMs?: number;
}

/** A node that only knows the container job contract — no docker adapter in reach. */
function fakeNode(existing?: ContainerInfo) {
  const jobs: FakeJob[] = [];
  const containers = new Map<string, ContainerInfo>();
  if (existing) containers.set(existing.name, existing);

  const run = async (
    kind: ContainerJobKind,
    args: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<unknown> => {
    jobs.push({ kind, args, timeoutMs: opts?.timeoutMs });
    const id = String(args.id ?? "");
    const find = (): ContainerInfo | undefined =>
      containers.get(id) ?? [...containers.values()].find((c) => c.id === id);
    switch (kind) {
      case "container_inspect": {
        const hit = find();
        if (!hit) throw new Error("job_failed: container_inspect: no such container");
        return hit;
      }
      case "container_create": {
        const name = String(args.name);
        const info: ContainerInfo = { id: `id-${name}`, name, status: "created" };
        containers.set(name, info);
        return info;
      }
      case "container_logs":
        return { lines: ["node-line-1"] };
      default:
        return { ok: true };
    }
  };

  return { jobs, containers, dispatch: run as unknown as ContainerJobDispatch };
}

function openRemoteDocker(node: ReturnType<typeof fakeNode>, serverId = "srv1") {
  return openServerRuntime(
    { serverId, mode: "docker", locality: "remote" },
    {
      containerName: `playon-${serverId}`,
      docker: remoteDockerTransport(node.dispatch, { serverId }),
      resolveContainerSpec: async () => SPEC,
    },
  );
}

describe("remote docker ServerRuntimeHandle", () => {
  it("creates then starts the container through container_* jobs", async () => {
    const node = fakeNode();

    const started = await openRemoteDocker(node).start();

    expect(started.id).toBe("id-playon-srv1");
    expect(node.jobs.map((j) => j.kind)).toEqual([
      "container_inspect",
      "container_create",
      "container_start",
    ]);
    expect(node.jobs[1]!.args).toEqual({
      name: "playon-srv1",
      image: "playon/fixture:latest",
      env: { A: "1" },
      ports: [{ host: 25565, container: 25565, protocol: "tcp" }],
      binds: [],
    });
  });

  it("re-resolves identity on the node instead of creating a second container", async () => {
    const node = fakeNode({ id: "abc123", name: "playon-srv1", status: "exited" });

    const started = await openRemoteDocker(node).start();

    expect(started.id).toBe("abc123");
    expect(node.jobs.map((j) => j.kind)).toEqual(["container_inspect", "container_start"]);
    expect(node.jobs[1]!.args.id).toBe("abc123");
  });

  it("tags start and stop with the server so the agent follows the right console", async () => {
    const node = fakeNode({ id: "abc123", name: "playon-srv1", status: "running" });

    await openRemoteDocker(node).stop();

    expect(node.jobs.at(-1)).toMatchObject({
      kind: "container_stop",
      args: { id: "abc123", serverId: "srv1" },
    });
  });

  it("reports node container state as runtime status, and missing when inspect fails", async () => {
    const running = fakeNode({ id: "abc123", name: "playon-srv1", status: "running" });
    await expect(openRemoteDocker(running).status()).resolves.toEqual({
      state: "running",
      id: "abc123",
      detail: "running",
    });

    await expect(openRemoteDocker(fakeNode()).status()).resolves.toEqual({ state: "missing" });
  });

  it("bounds inspect and gives create room for an image pull", async () => {
    const node = fakeNode();

    await openRemoteDocker(node).start();

    expect(node.jobs[0]!.timeoutMs).toBe(15_000);
    expect(node.jobs[1]!.timeoutMs).toBe(180_000);
  });

  it("tails logs and writes stdin over the same transport", async () => {
    const node = fakeNode({ id: "abc123", name: "playon-srv1", status: "running" });
    const handle = openRemoteDocker(node);

    await expect(handle.logs(20)).resolves.toEqual(["node-line-1"]);
    expect(node.jobs.at(-1)).toMatchObject({
      kind: "container_logs",
      args: { id: "abc123", tail: 20 },
    });

    await handle.writeStdin("say hi");
    expect(node.jobs.at(-1)).toMatchObject({
      kind: "container_stdin",
      args: { id: "abc123", line: "say hi" },
    });
  });
});

const PROCESS_SPEC: ServerProcessSpec = {
  command: "/bin/bash",
  args: ["/srv/srv1/game/start.sh"],
  env: { PLAYON_SERVER_ID: "srv1" },
  logFile: "/srv/srv1/logs/console.log",
};

const IDENTITY = { name: "server-srv1", cwd: "/srv/srv1/game" };

interface FakeNative extends NativeRuntimeTransport {
  calls: string[];
  running: ProcessInfo | null;
  specs: ProcessSpec[];
}

/** A host that only knows how to run and re-resolve a process for an identity. */
function fakeNativeTransport(opts?: { running?: ProcessInfo; stdio?: boolean }): FakeNative {
  const calls: string[] = [];
  const specs: ProcessSpec[] = [];
  const transport: FakeNative = {
    locality: "local",
    calls,
    specs,
    running: opts?.running ?? null,
    async resolve(identity) {
      calls.push(`resolve:${identity.name}:${identity.cwd}`);
      return transport.running;
    },
    async start(spec) {
      calls.push(`start:${spec.name}:${spec.cwd}`);
      specs.push(spec);
      const info: ProcessInfo = {
        id: `native-${spec.name}-1`,
        name: spec.name,
        pid: 4242,
        status: "running",
      };
      transport.running = info;
      return info;
    },
    async stop(identity, id) {
      calls.push(`stop:${identity.name}:${id ?? "no-id"}`);
      transport.running = null;
    },
    logs: opts?.stdio
      ? async (identity, tail) => {
          calls.push(`logs:${identity.name}:${tail ?? "all"}`);
          return ["native-line-1"];
        }
      : undefined,
    writeStdin: opts?.stdio
      ? async (identity, line) => {
          calls.push(`stdin:${identity.name}:${line}`);
        }
      : undefined,
  };
  return transport;
}

function openNativeAs(transport: NativeRuntimeTransport, identity: NativeProcessIdentity) {
  return openServerRuntime(
    { serverId: "srv1", mode: "native", locality: transport.locality },
    {
      containerName: "playon-srv1",
      processIdentity: identity,
      native: transport,
      resolveProcessSpec: async () => PROCESS_SPEC,
    },
  );
}

function openNative(transport: NativeRuntimeTransport) {
  return openNativeAs(transport, IDENTITY);
}

describe("native ServerRuntimeHandle", () => {
  it("starts the process under the handle-owned name and cwd", async () => {
    const transport = fakeNativeTransport();
    const handle = openNative(transport);

    const started = await handle.start();

    expect(handle.mode).toBe("native");
    expect(started.id).toBe("native-server-srv1-1");
    expect(transport.calls).toEqual([
      "resolve:server-srv1:/srv/srv1/game",
      "start:server-srv1:/srv/srv1/game",
    ]);
    expect(transport.specs[0]).toEqual({
      ...PROCESS_SPEC,
      name: "server-srv1",
      cwd: "/srv/srv1/game",
    });
  });

  it("stops a process it re-resolved before starting a second one", async () => {
    const transport = fakeNativeTransport({
      running: { id: "native-orphan-99", name: "server-srv1", pid: 99, status: "running" },
    });

    await openNative(transport).start();

    expect(transport.calls).toEqual([
      "resolve:server-srv1:/srv/srv1/game",
      "stop:server-srv1:native-orphan-99",
      "start:server-srv1:/srv/srv1/game",
    ]);
  });

  it("stops by identity, passing the re-resolved id as a hint", async () => {
    const transport = fakeNativeTransport({
      running: { id: "native-server-srv1-1", name: "server-srv1", pid: 7, status: "running" },
    });

    await openNative(transport).stop();

    expect(transport.calls).toEqual([
      "resolve:server-srv1:/srv/srv1/game",
      "stop:server-srv1:native-server-srv1-1",
    ]);
  });

  it("still fires stop when nothing resolved, so orphans get swept", async () => {
    const transport = fakeNativeTransport();

    await openNative(transport).stop();

    expect(transport.calls).toEqual([
      "resolve:server-srv1:/srv/srv1/game",
      "stop:server-srv1:no-id",
    ]);
  });

  it("restart stops before starting", async () => {
    const transport = fakeNativeTransport({
      running: { id: "native-server-srv1-1", name: "server-srv1", pid: 7, status: "running" },
    });

    await openNative(transport).restart();

    expect(transport.calls).toEqual([
      "resolve:server-srv1:/srv/srv1/game",
      "stop:server-srv1:native-server-srv1-1",
      "resolve:server-srv1:/srv/srv1/game",
      "start:server-srv1:/srv/srv1/game",
    ]);
  });

  it("maps process state onto runtime state, and reads absence as stopped", async () => {
    const running = openNative(
      fakeNativeTransport({
        running: { id: "p1", name: "server-srv1", pid: 7, status: "running" },
      }),
    );
    const exited = openNative(
      fakeNativeTransport({ running: { id: "p2", name: "server-srv1", status: "stopped" } }),
    );
    const gone = openNative(fakeNativeTransport());

    await expect(running.status()).resolves.toEqual({
      state: "running",
      id: "p1",
      detail: "running",
    });
    await expect(exited.status()).resolves.toEqual({
      state: "stopped",
      id: "p2",
      detail: "stopped",
    });
    await expect(gone.status()).resolves.toEqual({ state: "stopped" });
  });

  it("sweeps the identity when the re-resolve itself cannot answer", async () => {
    const transport = fakeNativeTransport();
    transport.resolve = async () => {
      transport.calls.push("resolve:unreachable");
      throw new Error("node_unreachable");
    };

    await openNative(transport).start();

    // Not knowing is not the same as knowing nothing runs: sweep before starting.
    expect(transport.calls).toEqual([
      "resolve:unreachable",
      "stop:server-srv1:no-id",
      "start:server-srv1:/srv/srv1/game",
    ]);
  });

  it("stops on an unanswerable re-resolve, but refuses to guess a status", async () => {
    const transport = fakeNativeTransport();
    transport.resolve = async () => {
      throw new Error("node_unreachable");
    };

    await openNative(transport).stop();
    expect(transport.calls).toEqual(["stop:server-srv1:no-id"]);

    await expect(openNative(transport).status()).rejects.toThrow(/node_unreachable/);
  });

  it("reports logs and stdin as unsupported when the transport cannot do them", async () => {
    const handle = openNative(fakeNativeTransport());

    await expect(handle.logs(20)).rejects.toThrow(/runtime_unsupported: native logs/);
    await expect(handle.writeStdin("say hi")).rejects.toThrow(/runtime_unsupported: native stdin/);
  });

  it("uses the transport's own logs and stdin when it has them", async () => {
    const transport = fakeNativeTransport({ stdio: true });
    const handle = openNative(transport);

    await expect(handle.logs(20)).resolves.toEqual(["native-line-1"]);
    await handle.writeStdin("say hi");
    expect(transport.calls).toEqual(["logs:server-srv1:20", "stdin:server-srv1:say hi"]);
  });
});

/** Records what the mode half asks of a supervisor, without spawning anything. */
function fakeSupervisor(opts?: { found?: ProcessInfo | null; reclaim?: boolean }) {
  const calls: string[] = [];
  const supervisor: ProcessSupervisor = {
    async start(spec) {
      calls.push(`start:${spec.name}:${spec.cwd}`);
      return { id: `native-${spec.name}-1`, name: spec.name, pid: 11, status: "running" };
    },
    async stop(id) {
      calls.push(`stop:${id}`);
    },
    async status(id) {
      return { id, name: id, status: "unknown" };
    },
    async find(name, cwd) {
      calls.push(`find:${name}:${cwd}`);
      return opts?.found ?? null;
    },
    reclaim:
      opts?.reclaim === false
        ? undefined
        : async (name, cwd) => {
            calls.push(`reclaim:${name}:${cwd}`);
          },
  };
  return { calls, supervisor };
}

describe("localNativeTransport", () => {
  it("re-resolves identity through the supervisor and reports local locality", async () => {
    const { calls, supervisor } = fakeSupervisor({
      found: { id: "native-server-srv1-1", name: "server-srv1", pid: 11, status: "running" },
    });
    const transport = localNativeTransport(supervisor);

    expect(transport.locality).toBe("local");
    await expect(openNative(transport).status()).resolves.toMatchObject({ state: "running" });
    expect(calls).toEqual(["find:server-srv1:/srv/srv1/game"]);
  });

  it("stops by identity so a lost process id cannot leave orphans behind", async () => {
    const { calls, supervisor } = fakeSupervisor({
      found: { id: "native-orphan-99", name: "server-srv1", pid: 99, status: "running" },
    });

    await openNative(localNativeTransport(supervisor)).stop();

    expect(calls).toEqual([
      "find:server-srv1:/srv/srv1/game",
      "reclaim:server-srv1:/srv/srv1/game",
    ]);
  });

  it("falls back to id-based stop for supervisors without reclaim", async () => {
    const { calls, supervisor } = fakeSupervisor({
      found: { id: "native-server-srv1-1", name: "server-srv1", pid: 11, status: "running" },
      reclaim: false,
    });

    await openNative(localNativeTransport(supervisor)).stop();

    expect(calls).toEqual(["find:server-srv1:/srv/srv1/game", "stop:native-server-srv1-1"]);
  });

  it("passes the resolved spec straight to the supervisor", async () => {
    const { calls, supervisor } = fakeSupervisor();

    const started = await openNative(localNativeTransport(supervisor)).start();

    expect(started.id).toBe("native-server-srv1-1");
    expect(calls).toEqual([
      "find:server-srv1:/srv/srv1/game",
      "start:server-srv1:/srv/srv1/game",
    ]);
  });

  it("tails the console file named by the identity", async () => {
    const logFile = path.join(tempDir(), "console.log");
    fs.writeFileSync(logFile, "one\ntwo\nthree\n");
    const { supervisor } = fakeSupervisor();

    const handle = openNativeAs(localNativeTransport(supervisor), { ...IDENTITY, logFile });

    await expect(handle.logs(2)).resolves.toEqual(["two", "three"]);
  });

  it("tails nothing for an identity with no console file, and for one not written yet", async () => {
    const { supervisor } = fakeSupervisor();
    const transport = localNativeTransport(supervisor);
    const unwritten = path.join(tempDir(), "console.log");

    await expect(openNative(transport).logs(20)).resolves.toEqual([]);
    await expect(
      openNativeAs(transport, { ...IDENTITY, logFile: unwritten }).logs(20),
    ).resolves.toEqual([]);
  });
});

/** Identity and spec as a node sees them: every path is jail-relative. */
const REMOTE_IDENTITY: NativeProcessIdentity = { name: "server-srv1", cwd: "servers/srv1/game" };
const REMOTE_PROCESS_SPEC: ServerProcessSpec = {
  command: "/bin/bash",
  args: ["start.sh"],
  env: { PLAYON_SERVER_ID: "srv1" },
  logFile: "servers/srv1/logs/console.log",
};

interface FakeProcessJob {
  kind: ProcessJobKind;
  args: Record<string, unknown>;
  timeoutMs?: number;
}

/** A node that only knows the process job contract — no supervisor in reach. */
function fakeProcessNode(opts?: { running?: ProcessInfo; unreachable?: boolean }) {
  const jobs: FakeProcessJob[] = [];
  const state = { running: opts?.running ?? null as ProcessInfo | null };
  let seq = 0;

  const run = async (
    kind: ProcessJobKind,
    args: Record<string, unknown>,
    o?: { timeoutMs?: number },
  ): Promise<unknown> => {
    jobs.push({ kind, args, timeoutMs: o?.timeoutMs });
    if (opts?.unreachable) throw new Error("job_timeout: node did not answer");
    const name = String(args.name ?? "");
    switch (kind) {
      case "process_status":
        // An identity the node cannot find still gets an answer, just a stopped one.
        return state.running ?? { id: name, name, status: "stopped" };
      case "process_start":
        state.running = { id: `native-${name}-${++seq}`, name, pid: 900 + seq, status: "running" };
        return state.running;
      default:
        state.running = null;
        return { ok: true };
    }
  };

  return { jobs, state, dispatch: run as unknown as ProcessJobDispatch };
}

function openRemoteNative(node: ReturnType<typeof fakeProcessNode>, serverId = "srv1") {
  return openServerRuntime(
    { serverId, mode: "native", locality: "remote" },
    {
      containerName: `playon-${serverId}`,
      processIdentity: REMOTE_IDENTITY,
      native: remoteNativeTransport(node.dispatch, { serverId }),
      resolveProcessSpec: async () => REMOTE_PROCESS_SPEC,
    },
  );
}

describe("remote native ServerRuntimeHandle", () => {
  it("re-resolves by identity, then starts the process through process_* jobs", async () => {
    const node = fakeProcessNode();

    const started = await openRemoteNative(node).start();

    expect(started.id).toBe("native-server-srv1-1");
    expect(node.jobs.map((j) => j.kind)).toEqual(["process_status", "process_start"]);
    // Nothing is addressed by a stored id: the node is asked who it has running.
    expect(node.jobs[0]!.args).toEqual({ name: "server-srv1", cwd: "servers/srv1/game" });
    expect(node.jobs[1]!.args).toEqual({
      name: "server-srv1",
      command: "/bin/bash",
      args: ["start.sh"],
      cwd: "servers/srv1/game",
      env: { PLAYON_SERVER_ID: "srv1" },
      serverId: "srv1",
      logRel: "servers/srv1/logs/console.log",
    });
  });

  it("stops a process the node already runs instead of stacking a second one", async () => {
    const node = fakeProcessNode({
      running: { id: "native-orphan-99", name: "server-srv1", pid: 99, status: "running" },
    });

    await openRemoteNative(node).start();

    expect(node.jobs.map((j) => j.kind)).toEqual([
      "process_status",
      "process_stop",
      "process_start",
    ]);
    expect(node.jobs[1]!.args).toEqual({
      id: "native-orphan-99",
      name: "server-srv1",
      cwd: "servers/srv1/game",
      serverId: "srv1",
    });
  });

  it("stops by identity, so a node-agent restart cannot leave an orphan", async () => {
    const node = fakeProcessNode();

    await openRemoteNative(node).stop();

    expect(node.jobs.map((j) => j.kind)).toEqual(["process_status", "process_stop"]);
    expect(node.jobs.at(-1)!.args).toEqual({
      id: "",
      name: "server-srv1",
      cwd: "servers/srv1/game",
      serverId: "srv1",
    });
  });

  it("reports the node's process state, and absence as stopped", async () => {
    const running = fakeProcessNode({
      running: { id: "native-server-srv1-1", name: "server-srv1", pid: 7, status: "running" },
    });
    await expect(openRemoteNative(running).status()).resolves.toEqual({
      state: "running",
      id: "native-server-srv1-1",
      detail: "running",
    });

    await expect(openRemoteNative(fakeProcessNode()).status()).resolves.toEqual({
      state: "stopped",
    });
  });

  it("bounds the re-resolve so status cannot park behind an unreachable node", async () => {
    const node = fakeProcessNode();

    await openRemoteNative(node).status();

    expect(node.jobs[0]!.timeoutMs).toBe(15_000);
  });

  it("refuses to answer for a node that never answered", async () => {
    const node = fakeProcessNode({ unreachable: true });

    await expect(openRemoteNative(node).status()).rejects.toThrow(/job_timeout/);
  });
});

/** A console file living on the node, readable only through the fs job contract. */
function fakeNodeConsole(text: string) {
  const reads: Array<{ path: string; offset: number; maxBytes?: number }> = [];
  const bytes = Buffer.from(text, "utf8");
  const readText: NodeTextReadDispatch = async (args) => {
    const offset = args.offset ?? 0;
    reads.push({ path: args.path, offset, maxBytes: args.maxBytes });
    const slice = bytes.subarray(
      offset,
      args.maxBytes == null ? undefined : offset + args.maxBytes,
    );
    return {
      path: args.path,
      content: slice.toString("utf8"),
      bytesRead: slice.length,
      truncated: offset + slice.length < bytes.length,
      size: bytes.length,
    };
  };
  return { reads, readText };
}

const REMOTE_LOG_IDENTITY: NativeProcessIdentity = {
  ...REMOTE_IDENTITY,
  logFile: "servers/srv1/logs/console.log",
};

function openRemoteNativeConsole(
  node: ReturnType<typeof fakeProcessNode>,
  readText?: NodeTextReadDispatch,
  identity: NativeProcessIdentity = REMOTE_LOG_IDENTITY,
) {
  return openServerRuntime(
    { serverId: "srv1", mode: "native", locality: "remote" },
    {
      containerName: "playon-srv1",
      processIdentity: identity,
      native: remoteNativeTransport(node.dispatch, { serverId: "srv1", readText }),
      resolveProcessSpec: async () => REMOTE_PROCESS_SPEC,
    },
  );
}

describe("remote native logs", () => {
  it("tails the node's console file over the fs job contract", async () => {
    const nodeConsole = fakeNodeConsole("one\ntwo\nthree\n");

    const lines = await openRemoteNativeConsole(fakeProcessNode(), nodeConsole.readText).logs(2);

    expect(lines).toEqual(["two", "three"]);
    expect(nodeConsole.reads[0]).toEqual({
      path: "servers/srv1/logs/console.log",
      offset: 0,
      maxBytes: 1,
    });
  });

  it("reads from the end of a long console, never its head", async () => {
    const head = `${"x".repeat(150_000)}\n`;
    const nodeConsole = fakeNodeConsole(`${head}last\n`);

    const lines = await openRemoteNativeConsole(fakeProcessNode(), nodeConsole.readText).logs(1);

    expect(lines).toEqual(["last"]);
    // The probe reports the size; the real read only pulls the trailing window.
    const size = Buffer.byteLength(`${head}last\n`, "utf8");
    expect(nodeConsole.reads[1]).toEqual({
      path: "servers/srv1/logs/console.log",
      offset: size - 128_000,
      maxBytes: 128_000,
    });
  });

  it("stops after the probe when the node's console is still empty", async () => {
    const nodeConsole = fakeNodeConsole("");

    await expect(
      openRemoteNativeConsole(fakeProcessNode(), nodeConsole.readText).logs(20),
    ).resolves.toEqual([]);
    expect(nodeConsole.reads).toHaveLength(1);
  });

  it("has nothing to tail for an identity with no console file", async () => {
    const nodeConsole = fakeNodeConsole("one\n");

    await expect(
      openRemoteNativeConsole(
        fakeProcessNode(),
        nodeConsole.readText,
        REMOTE_IDENTITY,
      ).logs(20),
    ).resolves.toEqual([]);
    expect(nodeConsole.reads).toEqual([]);
  });

  it("reports logs unsupported when no console wire was lent", async () => {
    await expect(openRemoteNativeConsole(fakeProcessNode()).logs(20)).rejects.toThrow(
      /runtime_unsupported: native logs over remote transport/,
    );
  });
});

describe("openServerRuntime", () => {
  it("refuses native quadrants with no transport, so remote native fails loudly", () => {
    expect(() =>
      openServerRuntime(
        { serverId: "srv1", mode: "native", locality: "remote" },
        { containerName: "playon-srv1" },
      ),
    ).toThrow(RuntimeUnsupportedError);
  });

  it("refuses a native runtime with no identity to re-resolve", () => {
    expect(() =>
      openServerRuntime(
        { serverId: "srv1", mode: "native", locality: "local" },
        {
          containerName: "playon-srv1",
          native: fakeNativeTransport(),
          resolveProcessSpec: async () => PROCESS_SPEC,
        },
      ),
    ).toThrow(/runtime_identity_missing/);
  });

  it("refuses docker quadrants with no transport", () => {
    expect(() =>
      openServerRuntime(
        { serverId: "srv1", mode: "docker", locality: "remote" },
        { containerName: "playon-srv1" },
      ),
    ).toThrow(/runtime_unsupported: docker remote/);
  });

  it("refuses a transport whose locality contradicts the target", () => {
    expect(() =>
      openServerRuntime(
        { serverId: "srv1", mode: "docker", locality: "remote" },
        {
          containerName: "playon-srv1",
          docker: fakeDockerTransport({ locality: "local" }),
          resolveContainerSpec: async () => SPEC,
        },
      ),
    ).toThrow(/runtime_locality_mismatch/);
  });
});
