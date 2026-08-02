import { DockerodeAdapter } from "./dockerode-adapter.js";
import { NativeProcessSupervisor } from "./native-process.js";
import type { ContainerInfo, ContainerSpec, DockerAdapter, ProcessSupervisor } from "./types.js";

export type RuntimeAdapterMode = "docker";

export interface RuntimeAdapters {
  docker: DockerAdapter;
  process: ProcessSupervisor;
  mode: RuntimeAdapterMode;
}

/** Docker adapter that refuses container ops — used when host is native-only. */
export class UnavailableDockerAdapter implements DockerAdapter {
  private fail(): never {
    throw new Error(
      "docker_not_configured: this host is not running a Docker runtime; use a native skill or set PLAYON_RUNTIME=docker",
    );
  }
  async create(_spec: ContainerSpec): Promise<ContainerInfo> {
    this.fail();
  }
  async start(_id: string): Promise<void> {
    this.fail();
  }
  async stop(_id: string): Promise<void> {
    this.fail();
  }
  async inspect(_id: string): Promise<ContainerInfo> {
    this.fail();
  }
  async logs(_id: string, _tail?: number): Promise<string[]> {
    this.fail();
  }
}

/**
 * Create runtime adapters.
 * - `docker`: real Docker engine + real OS process supervisor (fails if Docker unavailable)
 */
export async function createRuntimeAdapters(mode: RuntimeAdapterMode): Promise<RuntimeAdapters> {
  if (mode !== "docker") {
    throw new Error(`unsupported_runtime_mode: ${String(mode)}`);
  }

  try {
    const docker = new DockerodeAdapter();
    await docker.ping();
    return {
      docker,
      process: new NativeProcessSupervisor(),
      mode: "docker",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`docker_unavailable: ${message}`);
  }
}

/** Real OS processes only (no Docker). */
export function createNativeRuntimeAdapters(): RuntimeAdapters {
  return {
    docker: new UnavailableDockerAdapter(),
    process: new NativeProcessSupervisor(),
    mode: "docker",
  };
}
