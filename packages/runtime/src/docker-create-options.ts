import type Docker from "dockerode";
import type { DockerEngineIsolation, DockerEngineOs } from "./docker-engine.js";
import type { ContainerSpec } from "./types.js";

export type DockerEngineCreateContext = {
  osType: DockerEngineOs;
  isolation?: DockerEngineIsolation;
};

/**
 * Windows Server containers do not accept Unix bind destinations like `/data`.
 * `/data` → `C:\data`; already-Windows paths keep their drive letter.
 */
export function windowsContainerPath(containerPath: string): string {
  const trimmed = containerPath.trim();
  if (!trimmed || trimmed === "none" || trimmed === "-") return trimmed;
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return trimmed.replace(/\//g, "\\");
  }
  const unix = trimmed.replace(/\\/g, "/");
  if (unix.startsWith("/")) {
    const rest = unix.slice(1).replace(/\//g, "\\");
    return rest ? `C:\\${rest}` : "C:\\";
  }
  return trimmed;
}

export function formatDockerBind(
  hostPath: string,
  containerPath: string,
  engineOs: DockerEngineOs,
): string {
  const dest = engineOs === "windows" ? windowsContainerPath(containerPath) : containerPath;
  return `${hostPath}:${dest}`;
}

/** Windows console images (e.g. har0x/sbox-server) need `docker run -t`. */
export function resolveContainerTty(
  spec: Pick<ContainerSpec, "tty">,
  engineOs: DockerEngineOs,
): boolean {
  return spec.tty ?? engineOs === "windows";
}

/**
 * Prefer an explicit skill/spec isolation; otherwise the daemon default on
 * Windows (process on Server, hyperv on client). Linux omits the field.
 */
export function resolveContainerIsolation(
  spec: Pick<ContainerSpec, "isolation">,
  engine: DockerEngineCreateContext,
): DockerEngineIsolation | undefined {
  if (spec.isolation) return spec.isolation;
  if (engine.osType === "windows") return engine.isolation;
  return undefined;
}

export function buildContainerCreateOptions(
  spec: ContainerSpec,
  engine: DockerEngineCreateContext,
): Docker.ContainerCreateOptions {
  const exposed: Record<string, object> = {};
  const portBindings: Record<string, Array<{ HostPort: string }>> = {};
  for (const p of spec.ports ?? []) {
    const proto = p.protocol ?? "tcp";
    const key = `${p.container}/${proto}`;
    exposed[key] = {};
    portBindings[key] = [{ HostPort: String(p.host) }];
  }

  const binds = (spec.binds ?? []).map((b) =>
    formatDockerBind(b.hostPath, b.containerPath, engine.osType),
  );
  const cmd = spec.cmd?.filter((a) => a.length > 0);
  const tty = resolveContainerTty(spec, engine.osType);
  const isolation = resolveContainerIsolation(spec, engine);

  return {
    name: spec.name,
    Image: spec.image,
    Env: Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`),
    ...(cmd?.length ? { Cmd: cmd } : {}),
    // Keep stdin open so adminDialect=stdin can attach and write console commands.
    OpenStdin: true,
    AttachStdin: true,
    StdinOnce: false,
    Tty: tty,
    ExposedPorts: exposed,
    HostConfig: {
      PortBindings: portBindings as Docker.PortMap,
      Binds: binds.length ? binds : undefined,
      ...(isolation ? { Isolation: isolation } : {}),
    },
  };
}
