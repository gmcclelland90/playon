import {
  listHostContainers,
  sampleContainerUsage,
  sampleHostResources,
  sampleProcessUsage,
  type HostContainer,
} from "@playon/runtime";
import type { NodeHeartbeat } from "@playon/shared";
import { probeCapabilitiesForHeartbeat } from "./capabilities.js";
import { listSupervisedProcesses, SUPPORTED_JOB_KINDS } from "./jobs.js";

function wireContainer(c: HostContainer): NonNullable<NodeHeartbeat["containers"]>[number] {
  return {
    name: c.name,
    image: c.image,
    status: c.status,
    ...(c.ports.length ? { ports: c.ports } : {}),
    ...(c.cpuPercent != null ? { cpuPercent: c.cpuPercent } : {}),
    ...(c.memUsedBytes != null ? { memUsedBytes: c.memUsedBytes } : {}),
  };
}

export async function buildHeartbeat(opts: {
  nodeId: string;
  name: string;
  dataRoot: string;
  agentVersion?: string;
  listContainers?: () => Promise<HostContainer[]>;
  listProcesses?: () => import("@playon/runtime").ProcessInfo[];
}): Promise<NodeHeartbeat> {
  const caps = await probeCapabilitiesForHeartbeat(opts.dataRoot);
  const host = sampleHostResources(opts.dataRoot, { disk: caps.freeDiskBytes });
  const listed = await (opts.listContainers ?? listHostContainers)().catch(() => []);
  const running = listed.filter((c) => /running/i.test(c.status));
  const usage = running.length
    ? await sampleContainerUsage(
        running.map((c) => ({ name: c.name, id: c.id })),
      ).catch(() => new Map())
    : new Map();
  const containers = listed.map((c) => {
    const u = usage.get(c.name);
    return {
      ...c,
      ...(u?.cpuPercent != null ? { cpuPercent: u.cpuPercent } : {}),
      ...(u?.memUsedBytes != null ? { memUsedBytes: u.memUsedBytes } : {}),
    };
  });
  const processes = await sampleProcessUsage(
    (opts.listProcesses ?? listSupervisedProcesses)(),
  ).catch(() => []);
  return {
    nodeId: opts.nodeId,
    name: opts.name,
    os: caps.os,
    docker: caps.docker,
    native: caps.native,
    steamcmd: caps.steamcmd,
    freeDiskBytes: host.freeDiskBytes ?? caps.freeDiskBytes,
    ...(host.cpuPercent != null ? { cpuPercent: host.cpuPercent } : {}),
    memUsedBytes: host.memUsedBytes,
    memTotalBytes: host.memTotalBytes,
    agentVersion: opts.agentVersion ?? "0.1.0",
    // Protocol advertisement so the control plane can refuse kinds we cannot run.
    jobKinds: [...SUPPORTED_JOB_KINDS],
    ...(containers.length ? { containers: containers.map(wireContainer) } : {}),
    ...(processes.length
      ? {
          processes: processes.map((p) => ({
            name: p.name,
            ...(p.pid != null ? { pid: p.pid } : {}),
            status: p.status,
            ...(p.cpuPercent != null ? { cpuPercent: p.cpuPercent } : {}),
            ...(p.memUsedBytes != null ? { memUsedBytes: p.memUsedBytes } : {}),
          })),
        }
      : {}),
  };
}

export async function postHeartbeat(
  apiBase: string,
  payload: NodeHeartbeat,
  token?: string,
): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token?.trim()) headers.authorization = `Bearer ${token.trim()}`;
  const res = await fetch(`${apiBase.replace(/\/$/, "")}/api/nodes/heartbeat`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`heartbeat failed: ${res.status} ${await res.text()}`);
  }
}
