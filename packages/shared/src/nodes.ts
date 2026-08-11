export type NodePresence = "online" | "stale" | "offline";

/** How a node joined / where it lives relative to Home. */
export type NodeKind = "local" | "lan" | "cloud";

/** Product placement label derived from node kind. */
export type ComputePlacement = "local" | "remote" | "cloud";

/** WireGuard / LAN-presence tunnel health for cloud nodes. */
export type NodeTunnelStatus = "none" | "unconfigured" | "pending" | "up" | "down";

/** Durable id for the control-plane host’s local node. */
export const LOCAL_NODE_ID = "local";

/** Durable id for the WSL-backed Linux sibling of Windows `local`. */
export const LOCAL_WSL_NODE_ID = "local-wsl";

/** WSL distro name for the Linux runtime on Windows. */
export const WSL_DISTRO_NAME = "playon-linux";

/**
 * Sibling Linux node id for a Windows node's WSL runtime.
 * `local` → `local-wsl`; any other Windows node `N` → `N-wsl`.
 */
export function wslSiblingNodeId(windowsNodeId: string): string {
  const id = windowsNodeId.trim() || LOCAL_NODE_ID;
  if (id === LOCAL_NODE_ID) return LOCAL_WSL_NODE_ID;
  return `${id}-wsl`;
}

/** True when this node id is a WSL Linux sibling (`local-wsl` or `*-wsl`). */
export function isWslNodeId(nodeId: string | null | undefined): boolean {
  if (!nodeId) return false;
  return nodeId === LOCAL_WSL_NODE_ID || nodeId.endsWith("-wsl");
}

/** Parent Windows node id for a WSL sibling, or null if not a WSL id. */
export function wslParentNodeId(wslNodeId: string): string | null {
  if (wslNodeId === LOCAL_WSL_NODE_ID) return LOCAL_NODE_ID;
  if (wslNodeId.endsWith("-wsl") && wslNodeId.length > 4) {
    return wslNodeId.slice(0, -4);
  }
  return null;
}

/**
 * Home-side marker in a server's data dir: the game files live on the node, so
 * Home must not push its own (empty) tree over them.
 */
export const NODE_AUTHORITATIVE_MARKER = ".playon-node-authoritative";

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
  /** Node id for special badges like local-wsl / {nodeId}-wsl. */
  nodeId?: string | null;
}): string {
  if (isWslNodeId(opts.nodeId)) {
    const placement = placementFromNodeKind(opts.kind);
    if (placement === "local") return "Local · Linux (WSL)";
    return "Remote · Linux (WSL)";
  }
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
