import Docker from "dockerode";
import { WINDOWS_DOCKER_PIPES } from "./host-capabilities.js";
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

/** dockerode constructor options we set ourselves (never inherit a Linux DOCKER_HOST). */
export type DockerConnectOptions = {
  socketPath?: string;
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

/** `\\.\pipe\foo` → `//./pipe/foo` (dockerode's win32 socketPath form). */
export function toDockerodePipePath(windowsPipe: string): string {
  const prefix = "\\\\.\\pipe\\";
  if (windowsPipe.toLowerCase().startsWith(prefix.toLowerCase())) {
    return `//./pipe/${windowsPipe.slice(prefix.length)}`;
  }
  return windowsPipe;
}

/**
 * Named-pipe clients for a Windows-container engine, most specific first.
 * Passing `socketPath` makes dockerode ignore `DOCKER_HOST` (often the Linux/WSL engine).
 */
export function windowsDockerEngineConnectOptions(): DockerConnectOptions[] {
  return WINDOWS_DOCKER_PIPES.map((pipe) => ({ socketPath: toDockerodePipePath(pipe) }));
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("docker_info_timeout")), timeoutMs);
    }),
  ]);
}

/**
 * Windows: first pipe whose `docker info` OSType is windows.
 * Linux: `undefined` so dockerode uses the unix socket / DOCKER_HOST (WSL sibling).
 */
export async function resolveDockerClientOptions(opts?: {
  platform?: NodeJS.Platform;
  probe?: (options: DockerConnectOptions) => Promise<DockerInfoLike>;
  timeoutMs?: number;
}): Promise<DockerConnectOptions | undefined> {
  const platform = opts?.platform ?? process.platform;
  if (platform !== "win32") return undefined;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_INFO_TIMEOUT_MS;
  const probe =
    opts?.probe ??
    (async (options) => {
      const docker = new Docker(options);
      await docker.ping();
      return (await docker.info()) as DockerInfoLike;
    });
  for (const options of windowsDockerEngineConnectOptions()) {
    try {
      const raw = await withTimeout(probe(options), timeoutMs);
      if (parseDockerEngineInfo(raw)?.osType === "windows") return options;
    } catch {
      /* try the next pipe — docker_engine may be Desktop's Linux engine */
    }
  }
  return undefined;
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
  try {
    if (opts?.info) {
      return parseDockerEngineInfo(await withTimeout(opts.info(), timeoutMs));
    }
    if (process.platform === "win32") {
      const options = await resolveDockerClientOptions({ timeoutMs });
      if (!options) return null;
      const docker = new Docker(options);
      return parseDockerEngineInfo(
        await withTimeout(docker.info() as Promise<DockerInfoLike>, timeoutMs),
      );
    }
    const docker = new Docker();
    return parseDockerEngineInfo(
      await withTimeout(docker.info() as Promise<DockerInfoLike>, timeoutMs),
    );
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
