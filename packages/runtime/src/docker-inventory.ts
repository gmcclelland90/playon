import Docker from "dockerode";
import { resolveDockerClientOptions } from "./docker-engine.js";

const DEFAULT_LIST_TIMEOUT_MS = 2_000;
const MAX_INVENTORY = 80;

export type HostContainerPort = {
  host?: number;
  container: number;
  protocol?: "tcp" | "udp";
};

/** Read-only docker-ps row. Never used to create, start, or remove a container. */
export type HostContainer = {
  name: string;
  image: string;
  status: string;
  ports: HostContainerPort[];
  /** Engine id — used to sample stats; omitted from the heartbeat wire if unused. */
  id?: string;
  cpuPercent?: number;
  memUsedBytes?: number;
};

type DockerListPort = {
  PublicPort?: number;
  PrivatePort?: number;
  Type?: string;
};

type DockerListRow = {
  Id?: string;
  Names?: string[];
  Image?: string;
  State?: string;
  Status?: string;
  Ports?: DockerListPort[];
};

export function mapDockerListContainer(raw: DockerListRow | null | undefined): HostContainer | null {
  if (!raw) return null;
  const name = String(raw.Names?.[0] ?? "")
    .replace(/^\//, "")
    .trim();
  if (!name) return null;
  const image = String(raw.Image ?? "").trim() || "unknown";
  const status = String(raw.State ?? raw.Status ?? "unknown").toLowerCase();
  const ports: HostContainerPort[] = [];
  for (const p of raw.Ports ?? []) {
    const container = Number(p.PrivatePort);
    if (!Number.isFinite(container) || container < 1) continue;
    const host = Number(p.PublicPort);
    const proto = String(p.Type ?? "").toLowerCase();
    ports.push({
      container,
      ...(Number.isFinite(host) && host > 0 ? { host } : {}),
      ...(proto === "tcp" || proto === "udp" ? { protocol: proto } : {}),
    });
  }
  const id = String(raw.Id ?? "").trim();
  return { name, image, status, ports, ...(id ? { id } : {}) };
}

/**
 * List containers on the engine this host should use (Windows named pipe on
 * win32, default socket / DOCKER_HOST on Linux). Read-only — no create/start.
 */
export async function listHostContainers(opts?: {
  list?: () => Promise<DockerListRow[]>;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
}): Promise<HostContainer[]> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
  const listFn =
    opts?.list ??
    (async () => {
      const platform = opts?.platform ?? process.platform;
      const options =
        platform === "win32" ? await resolveDockerClientOptions({ platform, timeoutMs }) : undefined;
      if (platform === "win32" && !options) return [];
      const docker = new Docker(options);
      return (await docker.listContainers({ all: true })) as DockerListRow[];
    });
  try {
    const rows = await Promise.race([
      listFn(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("docker_list_timeout")), timeoutMs);
      }),
    ]);
    const out: HostContainer[] = [];
    for (const row of rows) {
      const mapped = mapDockerListContainer(row);
      if (mapped) out.push(mapped);
      if (out.length >= MAX_INVENTORY) break;
    }
    return out;
  } catch {
    return [];
  }
}
