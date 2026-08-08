import type { NodeJobArgsInput, NodeJobKind, NodeJobResult } from "@playon/shared";
import { followLogFile, readLogFileTail } from "./file-log-tail.js";
import type {
  ContainerInfo,
  ContainerSpec,
  DockerAdapter,
  LogFollowHandle,
  ProcessInfo,
  ProcessSpec,
  ProcessSupervisor,
  RuntimeMode,
} from "./types.js";

const NOOP_FOLLOW: LogFollowHandle = { abort: () => undefined };

/** Where the runtime work executes: in this process, or on a node over the job transport. */
export type RuntimeLocality = "local" | "remote";

export type ServerRuntimeState = "running" | "stopped" | "missing" | "unknown";

export interface ServerRuntimeStatus {
  state: ServerRuntimeState;
  /** Runtime-native id when the target exists (container id today, process id later). */
  id?: string;
  /** Mode-specific label behind `state`, e.g. docker `exited`. */
  detail?: string;
}

/** Thrown for quadrants (mode × locality) or capabilities that are not wired yet. */
export class RuntimeUnsupportedError extends Error {
  constructor(what: string) {
    super(`runtime_unsupported: ${what}`);
    this.name = "RuntimeUnsupportedError";
  }
}

/**
 * The lifecycle surface every mode × locality combination implements.
 * Callers never see `DockerAdapter` / `ProcessSupervisor` — those stay mode internals.
 */
export interface ServerRuntimeHandle {
  readonly mode: RuntimeMode;
  readonly locality: RuntimeLocality;
  start(): Promise<{ id: string }>;
  stop(): Promise<void>;
  restart(): Promise<{ id: string }>;
  status(): Promise<ServerRuntimeStatus>;
  logs(tail?: number): Promise<string[]>;
  /**
   * Stream new log lines until the returned handle is aborted.
   * Remote locality is a no-op: the node-agent already fans lines into Home.
   */
  followLogs(onLine: (line: string) => void): Promise<LogFollowHandle>;
  /**
   * Whether this quadrant has a console to write to at all. Callers need the
   * capability before the state: "this runtime never accepts input" and "the
   * server is not up yet" are different answers to give a player.
   */
  readonly canWriteStdin: boolean;
  writeStdin(line: string): Promise<void>;
}

/** Container spec minus identity — the handle owns naming so identity stays re-resolvable. */
export type ServerContainerSpec = Omit<ContainerSpec, "name">;

/**
 * Locality half of the docker mode: the same container verbs executed either
 * in-process (local) or via a node job (remote).
 */
export interface DockerRuntimeTransport {
  readonly locality: RuntimeLocality;
  inspect(id: string): Promise<ContainerInfo>;
  create(spec: ContainerSpec): Promise<ContainerInfo>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  logs(id: string, tail?: number): Promise<string[]>;
  followLogs?(id: string, onLine: (line: string) => void): Promise<LogFollowHandle>;
  writeStdin?(id: string, line: string): Promise<void>;
}

export function localDockerTransport(adapter: DockerAdapter): DockerRuntimeTransport {
  const writeStdin = adapter.writeStdin?.bind(adapter);
  const followLogs = adapter.followLogs?.bind(adapter);
  return {
    locality: "local",
    inspect: (id) => adapter.inspect(id),
    create: (spec) => adapter.create(spec),
    start: (id) => adapter.start(id),
    stop: (id) => adapter.stop(id),
    logs: (id, tail) => adapter.logs(id, tail),
    followLogs,
    writeStdin,
  };
}

/** The container half of the node job contract — the only kinds a remote docker runtime sends. */
export type ContainerJobKind = Extract<NodeJobKind, `container_${string}`>;

/**
 * The wire the control plane lends the runtime: run one container job on the node
 * that hosts this server. Which job each container verb maps to stays here, with
 * the docker mode adapter.
 */
export type ContainerJobDispatch = <K extends ContainerJobKind>(
  kind: K,
  args: NodeJobArgsInput<K>,
  opts?: { timeoutMs?: number },
) => Promise<NodeJobResult<K>>;

export interface RemoteDockerTransportOptions {
  /** Passed with start/stop so the agent knows whose console to follow. */
  serverId?: string;
  /** Create pulls the image on the node, so it gets a much longer leash. */
  createTimeoutMs?: number;
  /** Identity re-resolution must not park status calls behind an unreachable node. */
  inspectTimeoutMs?: number;
}

const REMOTE_CREATE_TIMEOUT_MS = 180_000;
const REMOTE_INSPECT_TIMEOUT_MS = 15_000;

export function remoteDockerTransport(
  dispatch: ContainerJobDispatch,
  opts: RemoteDockerTransportOptions = {},
): DockerRuntimeTransport {
  const serverId = opts.serverId;
  const inspectTimeoutMs = opts.inspectTimeoutMs ?? REMOTE_INSPECT_TIMEOUT_MS;
  return {
    locality: "remote",
    async inspect(id) {
      return dispatch("container_inspect", { id }, { timeoutMs: inspectTimeoutMs });
    },
    async create(spec) {
      return dispatch(
        "container_create",
        {
          name: spec.name,
          image: spec.image,
          env: spec.env ?? {},
          ports: spec.ports ?? [],
          binds: spec.binds ?? [],
        },
        { timeoutMs: opts.createTimeoutMs ?? REMOTE_CREATE_TIMEOUT_MS },
      );
    },
    async start(id) {
      await dispatch("container_start", { id, serverId });
    },
    async stop(id) {
      await dispatch("container_stop", { id, serverId });
    },
    async logs(id, tail) {
      const result = await dispatch("container_logs", tail == null ? { id } : { id, tail });
      return result.lines;
    },
    async writeStdin(id, line) {
      await dispatch("container_stdin", { id, line });
    },
  };
}

function mapContainerState(status: ContainerInfo["status"]): ServerRuntimeState {
  if (status === "running") return "running";
  if (status === "unknown") return "unknown";
  return "stopped";
}

class DockerRuntimeHandle implements ServerRuntimeHandle {
  readonly mode = "docker" as const;

  constructor(
    private readonly transport: DockerRuntimeTransport,
    private readonly containerName: string,
    private readonly resolveSpec: () => Promise<ServerContainerSpec>,
  ) {}

  get locality(): RuntimeLocality {
    return this.transport.locality;
  }

  private async resolveContainerId(): Promise<string | null> {
    try {
      const info = await this.transport.inspect(this.containerName);
      return info.id;
    } catch {
      return null;
    }
  }

  async start(): Promise<{ id: string }> {
    let id = await this.resolveContainerId();
    if (!id) {
      const spec = await this.resolveSpec();
      const created = await this.transport.create({ ...spec, name: this.containerName });
      id = created.id;
    }
    await this.transport.start(id);
    return { id };
  }

  async stop(): Promise<void> {
    const id = await this.resolveContainerId();
    if (!id) return;
    await this.transport.stop(id);
  }

  async restart(): Promise<{ id: string }> {
    await this.stop();
    return this.start();
  }

  async status(): Promise<ServerRuntimeStatus> {
    try {
      const info = await this.transport.inspect(this.containerName);
      return { state: mapContainerState(info.status), id: info.id, detail: info.status };
    } catch {
      return { state: "missing" };
    }
  }

  async logs(tail?: number): Promise<string[]> {
    const id = await this.resolveContainerId();
    if (!id) return [];
    return this.transport.logs(id, tail);
  }

  async followLogs(onLine: (line: string) => void): Promise<LogFollowHandle> {
    const follow = this.transport.followLogs;
    if (!follow) return NOOP_FOLLOW;
    const id = await this.resolveContainerId();
    if (!id) return NOOP_FOLLOW;
    return follow(id, onLine);
  }

  get canWriteStdin(): boolean {
    return typeof this.transport.writeStdin === "function";
  }

  async writeStdin(line: string): Promise<void> {
    const write = this.transport.writeStdin;
    if (!write) {
      throw new RuntimeUnsupportedError(`docker stdin over ${this.locality} transport`);
    }
    const id = await this.resolveContainerId();
    if (!id) throw new Error("container_missing");
    await write(id, line);
  }
}

/**
 * What a native runtime target is called on its host. The handle re-resolves the
 * OS process from this on every call, so no process id is ever stored.
 */
export interface NativeProcessIdentity {
  /** Supervisor-visible process name, e.g. `server-<id>`. */
  name: string;
  /** Game process working directory: absolute locally, jail-relative on a node. */
  cwd: string;
  /**
   * Console file the process appends to: absolute locally, jail-relative on a
   * node. A native target leaves no log stream behind it, so this file is the
   * only thing the runtime can tail — and it must be re-derivable, never stored.
   */
  logFile?: string;
}

/** Process spec minus identity — the handle owns naming so identity stays re-resolvable. */
export type ServerProcessSpec = Omit<ProcessSpec, "name" | "cwd">;

/**
 * Locality half of the native mode: the same process verbs executed either
 * in-process (local) or on a node over the job transport.
 */
export interface NativeRuntimeTransport {
  readonly locality: RuntimeLocality;
  /**
   * Re-resolve the process behind an identity; null when nothing is running.
   * Throwing means "cannot say" (an unreachable host), which is not the same
   * answer as null — status reports it instead of inventing "stopped".
   */
  resolve(identity: NativeProcessIdentity): Promise<ProcessInfo | null>;
  start(spec: ProcessSpec): Promise<ProcessInfo>;
  /** Stop by identity; `id` is a hint only, and a dead target is not an error. */
  stop(identity: NativeProcessIdentity, id?: string): Promise<void>;
  logs?(identity: NativeProcessIdentity, tail?: number): Promise<string[]>;
  followLogs?(identity: NativeProcessIdentity, onLine: (line: string) => void): LogFollowHandle;
  writeStdin?(identity: NativeProcessIdentity, line: string): Promise<void>;
}

export function localNativeTransport(supervisor: ProcessSupervisor): NativeRuntimeTransport {
  const reclaim = supervisor.reclaim?.bind(supervisor);
  const writeStdin = supervisor.writeStdin?.bind(supervisor);
  return {
    locality: "local",
    resolve: (identity) => supervisor.find(identity.name, identity.cwd),
    start: (spec) => supervisor.start(spec),
    async stop(identity, id) {
      // Reclaim is the identity-shaped stop: it also sweeps orphans a lost id would leave.
      if (reclaim) {
        await reclaim(identity.name, identity.cwd);
        return;
      }
      if (id) await supervisor.stop(id);
    },
    async logs(identity, tail) {
      if (!identity.logFile) return [];
      return readLogFileTail(identity.logFile, tail);
    },
    followLogs(identity, onLine) {
      if (!identity.logFile) return NOOP_FOLLOW;
      return followLogFile(identity.logFile, onLine);
    },
    // Identity-shaped like the rest: the supervisor owns the pipe, not the caller.
    writeStdin: writeStdin
      ? (identity, line) => writeStdin(identity.name, identity.cwd, line)
      : undefined,
  };
}

/** The process half of the node job contract — the only kinds a remote native runtime sends. */
export type ProcessJobKind = Extract<NodeJobKind, `process_${string}`>;

/**
 * The wire the control plane lends the runtime: run one process job on the node
 * that hosts this server. Which job each process verb maps to stays here, with
 * the native mode adapter.
 */
export type ProcessJobDispatch = <K extends ProcessJobKind>(
  kind: K,
  args: NodeJobArgsInput<K>,
  opts?: { timeoutMs?: number },
) => Promise<NodeJobResult<K>>;

/**
 * Reading a node's console file is an fs job, not a process one, so the native
 * mode needs a second wire to tail logs. Without it the runtime reports logs as
 * an unsupported capability rather than pretending the console is empty.
 */
export type NodeTextReadDispatch = (
  args: NodeJobArgsInput<"fs_read_text">,
  opts?: { timeoutMs?: number },
) => Promise<NodeJobResult<"fs_read_text">>;

export interface RemoteNativeTransportOptions {
  /** Passed with start/stop so the agent knows whose console to follow. */
  serverId?: string;
  /** A game start (and the reclaim before it) can take a while on a busy node. */
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** Identity re-resolution must not park status calls behind an unreachable node. */
  resolveTimeoutMs?: number;
  /** Wire for tailing the node-side console file; omit to leave logs unsupported. */
  readText?: NodeTextReadDispatch;
  logsTimeoutMs?: number;
}

const REMOTE_PROCESS_START_TIMEOUT_MS = 60_000;
const REMOTE_PROCESS_STOP_TIMEOUT_MS = 60_000;
const REMOTE_PROCESS_RESOLVE_TIMEOUT_MS = 15_000;
const REMOTE_LOGS_TIMEOUT_MS = 15_000;
/** Tail window pulled off a node console; long enough for 200 lines of any game. */
const REMOTE_LOGS_MAX_BYTES = 128_000;

function tailLines(text: string, tail?: number): string[] {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  return tail == null ? lines : lines.slice(-Math.max(1, tail));
}

/**
 * Locality half of the native mode over the node seam. Identity travels on every
 * job — the node owns the supervisor id, and this transport never stores one.
 * Paths in the identity and spec are jail-relative: the node resolves them under
 * its own data root.
 *
 * Console input is deliberately absent: the node job contract has no process
 * stdin kind, and only the node-side supervisor holds that pipe. Leaving it off
 * makes the handle report an unsupported capability instead of half-writing.
 */
export function remoteNativeTransport(
  dispatch: ProcessJobDispatch,
  opts: RemoteNativeTransportOptions = {},
): NativeRuntimeTransport {
  const serverId = opts.serverId;
  const readText = opts.readText;
  const logsTimeoutMs = opts.logsTimeoutMs ?? REMOTE_LOGS_TIMEOUT_MS;
  return {
    locality: "remote",
    async resolve(identity) {
      const info = await dispatch(
        "process_status",
        { name: identity.name, cwd: identity.cwd },
        { timeoutMs: opts.resolveTimeoutMs ?? REMOTE_PROCESS_RESOLVE_TIMEOUT_MS },
      );
      // The node answers "stopped" for an identity it cannot find, which is the
      // same nothing a local supervisor reports as null.
      return info.status === "stopped" ? null : info;
    },
    async start(spec) {
      return dispatch(
        "process_start",
        {
          name: spec.name,
          command: spec.command,
          args: spec.args ?? [],
          cwd: spec.cwd,
          env: spec.env ?? {},
          serverId,
          logRel: spec.logFile,
        },
        { timeoutMs: opts.startTimeoutMs ?? REMOTE_PROCESS_START_TIMEOUT_MS },
      );
    },
    async stop(identity, id) {
      // Name + cwd always travel: the node reclaims OS orphans a lost id would leave.
      await dispatch(
        "process_stop",
        { id: id ?? "", name: identity.name, cwd: identity.cwd, serverId },
        { timeoutMs: opts.stopTimeoutMs ?? REMOTE_PROCESS_STOP_TIMEOUT_MS },
      );
    },
    logs: readText
      ? async (identity, tail) => {
          if (!identity.logFile) return [];
          // Probe the size first: a read from offset 0 returns the head of a long
          // console, and the tail is the only part worth shipping back.
          const probe = await readText(
            { path: identity.logFile, offset: 0, maxBytes: 1 },
            { timeoutMs: logsTimeoutMs },
          );
          if (probe.size === 0) return [];
          const slice = await readText(
            {
              path: identity.logFile,
              offset: Math.max(0, probe.size - REMOTE_LOGS_MAX_BYTES),
              maxBytes: REMOTE_LOGS_MAX_BYTES,
            },
            { timeoutMs: logsTimeoutMs },
          );
          return tailLines(slice.content, tail);
        }
      : undefined,
  };
}

function mapProcessState(status: ProcessInfo["status"]): ServerRuntimeState {
  if (status === "running") return "running";
  if (status === "unknown") return "unknown";
  return "stopped";
}

class NativeRuntimeHandle implements ServerRuntimeHandle {
  readonly mode = "native" as const;

  constructor(
    private readonly transport: NativeRuntimeTransport,
    private readonly identity: NativeProcessIdentity,
    private readonly resolveSpec: () => Promise<ServerProcessSpec>,
  ) {}

  get locality(): RuntimeLocality {
    return this.transport.locality;
  }

  async start(): Promise<{ id: string }> {
    // Never stack duplicates: a live process for this identity goes first. A
    // re-resolve that cannot answer is treated as "maybe live" — sweeping an
    // identity that runs nothing is free, starting a second copy is not.
    let running: ProcessInfo | null = null;
    let answered = true;
    try {
      running = await this.transport.resolve(this.identity);
    } catch {
      answered = false;
    }
    if (!answered || running?.status === "running") {
      await this.transport.stop(this.identity, running?.id);
    }
    const spec = await this.resolveSpec();
    const info = await this.transport.start({
      ...spec,
      name: this.identity.name,
      cwd: this.identity.cwd,
    });
    return { id: info.id };
  }

  async stop(): Promise<void> {
    // The id is only a hint, so a re-resolve that fails must not hold up the stop.
    const running = await this.transport.resolve(this.identity).catch(() => null);
    // Fire even when nothing resolved: an identity stop doubles as the orphan sweep.
    await this.transport.stop(this.identity, running?.id);
  }

  async restart(): Promise<{ id: string }> {
    await this.stop();
    return this.start();
  }

  async status(): Promise<ServerRuntimeStatus> {
    const info = await this.transport.resolve(this.identity);
    // A native target leaves nothing behind when it exits, so absence is "stopped",
    // never docker's "missing".
    if (!info) return { state: "stopped" };
    return { state: mapProcessState(info.status), id: info.id, detail: info.status };
  }

  async logs(tail?: number): Promise<string[]> {
    const read = this.transport.logs;
    if (!read) {
      throw new RuntimeUnsupportedError(`native logs over ${this.locality} transport`);
    }
    return read(this.identity, tail);
  }

  async followLogs(onLine: (line: string) => void): Promise<LogFollowHandle> {
    const follow = this.transport.followLogs;
    if (!follow) return NOOP_FOLLOW;
    return follow(this.identity, onLine);
  }

  get canWriteStdin(): boolean {
    return typeof this.transport.writeStdin === "function";
  }

  async writeStdin(line: string): Promise<void> {
    const write = this.transport.writeStdin;
    if (!write) {
      throw new RuntimeUnsupportedError(`native stdin over ${this.locality} transport`);
    }
    await write(this.identity, line);
  }
}

export interface ServerRuntimeTarget {
  serverId: string;
  mode: RuntimeMode;
  locality: RuntimeLocality;
}

export interface ServerRuntimeDeps {
  /** Stable runtime identity for the docker mode; re-resolved on every call. */
  containerName: string;
  docker?: DockerRuntimeTransport;
  resolveContainerSpec?: () => Promise<ServerContainerSpec>;
  /** Stable runtime identity for the native mode; re-resolved on every call. */
  processIdentity?: NativeProcessIdentity;
  native?: NativeRuntimeTransport;
  resolveProcessSpec?: () => Promise<ServerProcessSpec>;
}

function assertLocality(target: ServerRuntimeTarget, transportLocality: RuntimeLocality): void {
  if (transportLocality === target.locality) return;
  throw new Error(
    `runtime_locality_mismatch: target ${target.locality} but transport ${transportLocality}`,
  );
}

/**
 * Pure factory over mode × locality. Callers pass the locality-flavoured transport;
 * the mode adapter is transport-agnostic. Unwired quadrants fail loudly.
 */
export function openServerRuntime(
  target: ServerRuntimeTarget,
  deps: ServerRuntimeDeps,
): ServerRuntimeHandle {
  if (target.mode === "native") {
    const transport = deps.native;
    if (!transport) {
      throw new RuntimeUnsupportedError(
        `native ${target.locality} runtime for server ${target.serverId}: no transport wired`,
      );
    }
    assertLocality(target, transport.locality);
    const identity = deps.processIdentity;
    if (!identity) {
      throw new Error(`runtime_identity_missing: native runtime for server ${target.serverId}`);
    }
    const resolveProcess = deps.resolveProcessSpec;
    if (!resolveProcess) {
      throw new Error(`runtime_spec_missing: native runtime for server ${target.serverId}`);
    }
    return new NativeRuntimeHandle(transport, identity, resolveProcess);
  }

  const transport = deps.docker;
  if (!transport) {
    throw new RuntimeUnsupportedError(
      `docker ${target.locality} runtime for server ${target.serverId}: no transport wired`,
    );
  }
  assertLocality(target, transport.locality);
  const resolveSpec = deps.resolveContainerSpec;
  if (!resolveSpec) {
    throw new Error(`runtime_spec_missing: docker runtime for server ${target.serverId}`);
  }

  return new DockerRuntimeHandle(transport, deps.containerName, resolveSpec);
}
