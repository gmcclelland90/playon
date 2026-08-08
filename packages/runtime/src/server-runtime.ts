import type { ContainerInfo, ContainerSpec, DockerAdapter, RuntimeMode } from "./types.js";

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
  writeStdin?(id: string, line: string): Promise<void>;
}

export function localDockerTransport(adapter: DockerAdapter): DockerRuntimeTransport {
  const writeStdin = adapter.writeStdin?.bind(adapter);
  return {
    locality: "local",
    inspect: (id) => adapter.inspect(id),
    create: (spec) => adapter.create(spec),
    start: (id) => adapter.start(id),
    stop: (id) => adapter.stop(id),
    logs: (id, tail) => adapter.logs(id, tail),
    writeStdin,
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
    throw new RuntimeUnsupportedError(
      `native ${target.locality} runtime for server ${target.serverId}`,
    );
  }

  const transport = deps.docker;
  if (!transport) {
    throw new RuntimeUnsupportedError(
      `docker ${target.locality} runtime for server ${target.serverId}: no transport wired`,
    );
  }
  if (transport.locality !== target.locality) {
    throw new Error(
      `runtime_locality_mismatch: target ${target.locality} but transport ${transport.locality}`,
    );
  }
  const resolveSpec = deps.resolveContainerSpec;
  if (!resolveSpec) {
    throw new Error(`runtime_spec_missing: docker runtime for server ${target.serverId}`);
  }

  return new DockerRuntimeHandle(transport, deps.containerName, resolveSpec);
}
