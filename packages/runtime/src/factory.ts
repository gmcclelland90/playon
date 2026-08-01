import { DockerodeAdapter } from "./dockerode-adapter.js";
import { MockDockerAdapter } from "./mock-docker.js";
import { MockProcessSupervisor } from "./mock-process.js";
import { NativeProcessSupervisor } from "./native-process.js";
import type { DockerAdapter, ProcessSupervisor } from "./types.js";

export type RuntimeAdapterMode = "mock" | "docker";

export interface RuntimeAdapters {
  docker: DockerAdapter;
  process: ProcessSupervisor;
  mode: RuntimeAdapterMode;
}

/**
 * Create runtime adapters. For `docker`, pings the engine and falls back to mock
 * when the daemon is unavailable (common on LAN hosts before Docker Desktop starts).
 */
export async function createRuntimeAdapters(
  mode: RuntimeAdapterMode,
): Promise<RuntimeAdapters> {
  if (mode === "mock") {
    return createMockRuntimeAdapters();
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
    console.warn(`[runtime] Docker unavailable (${message}); falling back to mock`);
    return createMockRuntimeAdapters();
  }
}

/** Sync helper for tests that only need mock. */
export function createMockRuntimeAdapters(): RuntimeAdapters {
  return {
    docker: new MockDockerAdapter(),
    process: new MockProcessSupervisor(),
    mode: "mock",
  };
}

