export type NodePresence = "online" | "stale" | "offline";

/** How a node joined / where it lives relative to Home. */
export type NodeKind = "local" | "lan" | "cloud";

/** Product placement label derived from node kind. */
export type ComputePlacement = "local" | "remote" | "cloud";

/** WireGuard / LAN-presence tunnel health for cloud nodes. */
export type NodeTunnelStatus = "none" | "unconfigured" | "pending" | "up" | "down";

/** Durable id for the control-plane host’s local node. */
export const LOCAL_NODE_ID = "local";

/** Default WireGuard overlay for cloud nodes (Home = .1). */
export const CLOUD_OVERLAY_CIDR = "10.77.0.0/24";
export const CLOUD_OVERLAY_HOME_IP = "10.77.0.1";
export const CLOUD_WG_INTERFACE = "playon0";
export const CLOUD_WG_LISTEN_PORT = 51820;

/** Default: 3× typical 5s heartbeat. */
export const NODE_ONLINE_MS = 15_000;
/** After this, treat the node as fully disconnected. */
export const NODE_OFFLINE_MS = 60_000;

export function isLocalNodeId(nodeId: string | null | undefined): boolean {
  return !nodeId || nodeId === LOCAL_NODE_ID;
}

export function placementFromNodeKind(kind: NodeKind | string | null | undefined): ComputePlacement {
  if (kind === "cloud") return "cloud";
  if (kind === "lan") return "remote";
  return "local";
}

export function placementBadge(opts: {
  kind: NodeKind | string | null | undefined;
  name?: string | null;
  tunnelStatus?: NodeTunnelStatus | string | null;
  rttMs?: number | null;
}): string {
  const placement = placementFromNodeKind(opts.kind);
  if (placement === "local") return "Local";
  if (placement === "cloud") {
    const bits = ["Cloud"];
    if (opts.name) bits.push(opts.name);
    if (opts.rttMs != null && Number.isFinite(opts.rttMs)) bits.push(`${Math.round(opts.rttMs)}ms`);
    else if (opts.tunnelStatus && opts.tunnelStatus !== "up" && opts.tunnelStatus !== "none") {
      bits.push(String(opts.tunnelStatus));
    }
    return bits.join(" · ");
  }
  return opts.name ? `Remote · ${opts.name}` : "Remote";
}

export function deriveNodePresence(
  lastSeenAt: Date | number | string,
  nowMs: number = Date.now(),
  onlineMs: number = NODE_ONLINE_MS,
  offlineMs: number = NODE_OFFLINE_MS,
): NodePresence {
  const seen =
    lastSeenAt instanceof Date
      ? lastSeenAt.getTime()
      : typeof lastSeenAt === "number"
        ? lastSeenAt
        : Date.parse(String(lastSeenAt));
  if (!Number.isFinite(seen)) return "offline";
  const age = nowMs - seen;
  if (age <= onlineMs) return "online";
  if (age <= offlineMs) return "stale";
  return "offline";
}
