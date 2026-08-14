import {
  probeHostCapabilities,
  refineDockerCapability,
  type HostCapabilities,
} from "@playon/runtime";

export type { HostCapabilities };

export function detectOs(): "linux" | "windows" {
  return probeHostCapabilities(process.cwd()).os;
}

export function dockerAvailable(): boolean {
  return probeHostCapabilities(process.cwd()).docker;
}

export function freeDiskBytes(dataRoot: string): number | undefined {
  return probeHostCapabilities(dataRoot).freeDiskBytes;
}

/** Sync socket/pipe probe — Linux heartbeats and tests. */
export function probeCapabilities(dataRoot: string): HostCapabilities {
  return probeHostCapabilities(dataRoot);
}

/**
 * Heartbeat / runtime_caps: on Windows, `docker` means a Windows-container
 * engine (OSType=windows), not Docker Desktop's Linux engine or WSL.
 */
export async function probeCapabilitiesForHeartbeat(dataRoot: string): Promise<HostCapabilities> {
  return refineDockerCapability(probeHostCapabilities(dataRoot));
}
