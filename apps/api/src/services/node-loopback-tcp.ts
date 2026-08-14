import { isLocalNodeId, type JoinPathPortState } from "@playon/shared";
import { nodeJobService } from "./node-jobs.js";

const NODE_LOOPBACK_TIMEOUT_MS = 8_000;

export type LoopbackTcpProbe = {
  state: JoinPathPortState;
  scope: "node" | "home";
  /** Job missing, timed out, or node does not advertise `net_tcp_connect`. */
  unavailable: boolean;
};

/**
 * Loopback TCP for the #843 join-path split.
 *
 * Local node: Home `127.0.0.1` is that node's localhost.
 * Remote node: `net_tcp_connect` on that agent. Never fall back to Home
 * (playon-dev soak Paper must not count as the game server).
 *
 * If the agent has not advertised the kind, return closed+unavailable immediately
 * so health/ready do not wait on a job that will never be claimed.
 */
export async function checkServerLoopbackTcp(
  nodeId: string | null | undefined,
  port: number,
  homeCheck: (host: string, port: number) => Promise<JoinPathPortState>,
): Promise<LoopbackTcpProbe> {
  if (isLocalNodeId(nodeId)) {
    return { state: await homeCheck("127.0.0.1", port), scope: "home", unavailable: false };
  }
  return checkNodeLoopbackTcp(nodeId, port);
}

export async function checkNodeLoopbackTcp(
  nodeId: string,
  port: number,
  host = "127.0.0.1",
): Promise<LoopbackTcpProbe> {
  const advertised = nodeJobService.advertisedJobKinds(nodeId);
  if (!advertised || !advertised.includes("net_tcp_connect")) {
    return { state: "closed", scope: "node", unavailable: true };
  }
  try {
    const job = nodeJobService.enqueue(nodeId, "net_tcp_connect", { host, port });
    const done = await nodeJobService.waitFor(job.id, { timeoutMs: NODE_LOOPBACK_TIMEOUT_MS });
    if (done.status === "failed" || !done.result || typeof done.result !== "object") {
      return { state: "closed", scope: "node", unavailable: true };
    }
    const state = (done.result as { state?: string }).state;
    if (state === "open" || state === "closed") {
      return { state, scope: "node", unavailable: false };
    }
    return { state: "closed", scope: "node", unavailable: true };
  } catch {
    return { state: "closed", scope: "node", unavailable: true };
  }
}
