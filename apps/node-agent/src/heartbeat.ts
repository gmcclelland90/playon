import type { NodeHeartbeat } from "@playon/shared";
import { probeCapabilities } from "./capabilities.js";

export function buildHeartbeat(opts: {
  nodeId: string;
  name: string;
  dataRoot: string;
  agentVersion?: string;
}): NodeHeartbeat {
  const caps = probeCapabilities(opts.dataRoot);
  return {
    nodeId: opts.nodeId,
    name: opts.name,
    os: caps.os,
    docker: caps.docker,
    native: caps.native,
    steamcmd: caps.steamcmd,
    freeDiskBytes: caps.freeDiskBytes,
    agentVersion: opts.agentVersion ?? "0.1.0",
  };
}

export async function postHeartbeat(
  apiBase: string,
  payload: NodeHeartbeat,
  token?: string,
): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token?.trim()) {
    headers.authorization = `Bearer ${token.trim()}`;
  }
  const res = await fetch(`${apiBase.replace(/\/$/, "")}/api/nodes/heartbeat`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`heartbeat failed: ${res.status} ${await res.text()}`);
  }
}
