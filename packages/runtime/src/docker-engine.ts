import Docker from "dockerode";
import type { HostCapabilities } from "./host-capabilities.js";

export type DockerEngineOs = "linux" | "windows";

export type DockerEngineIsolation = "process" | "hyperv";

export type DockerEngineInfo = {
  osType: DockerEngineOs;
  isolation?: DockerEngineIsolation;
};

/** Subset of `docker info` we care about (OSType + default Isolation). */
export type DockerInfoLike = {
  OSType?: string;
  osType?: string;
  Isolation?: string;
  isolation?: string;
};

const DEFAULT_INFO_TIMEOUT_MS = 2_000;

export function parseDockerEngineInfo(raw: DockerInfoLike | null | undefined): DockerEngineInfo | null {
  if (!raw) return null;
  const osType = String(raw.OSType ?? raw.osType ?? "").toLowerCase();
  if (osType !== "linux" && osType !== "windows") return null;
  const isolationRaw = String(raw.Isolation ?? raw.isolation ?? "").toLowerCase();
  const isolation: DockerEngineIsolation | undefined =
    isolationRaw === "process" || isolationRaw === "hyperv" ? isolationRaw : undefined;
  return { osType, isolation };
}

/**
 * Talk to the local Docker Engine. On Windows this is the source of truth for
 * "Windows container mode" — a named pipe can exist for Docker Desktop's Linux
 * engine, which must not count as Windows docker.
 */
export async function inspectDockerEngine(opts?: {
  info?: () => Promise<DockerInfoLike>;
  timeoutMs?: number;
}): Promise<DockerEngineInfo | null> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_INFO_TIMEOUT_MS;
  const infoFn =
    opts?.info ??
    (async () => {
      const docker = new Docker();
      return (await docker.info()) as DockerInfoLike;
    });
  try {
    const raw = await Promise.race([
      infoFn(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("docker_info_timeout")), timeoutMs);
      }),
    ]);
    return parseDockerEngineInfo(raw);
  } catch {
    return null;
  }
}

/**
 * Windows nodes report `docker: true` only when the engine OSType is windows.
 * Linux stays a socket-presence check (Linux engines are always linux).
 */
export async function refineDockerCapability(
  caps: HostCapabilities,
  inspect: () => Promise<DockerEngineInfo | null> = inspectDockerEngine,
): Promise<HostCapabilities> {
  if (caps.os !== "windows") return caps;
  const engine = await inspect();
  return { ...caps, docker: engine?.osType === "windows" };
}
