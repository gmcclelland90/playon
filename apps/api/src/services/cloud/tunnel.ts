/**
 * LAN-presence tunnel placeholder for Cloud placement (design-docs/14).
 * UDP-capable overlay (WireGuard / Tailscale) — implementation lands with Cloud MVP.
 */

export type TunnelStatus = "unconfigured" | "pending" | "up" | "down";

export interface CloudTunnelPlan {
  nodeId: string;
  /** Join address shown on the player panel (LAN-facing). */
  advertiseHost: string;
  status: TunnelStatus;
  detail?: string;
}

/** Record intent to bring a cloud node onto the LAN overlay. */
export function planCloudTunnel(opts: {
  nodeId: string;
  advertiseHost: string;
}): CloudTunnelPlan {
  return {
    nodeId: opts.nodeId,
    advertiseHost: opts.advertiseHost,
    status: "unconfigured",
    detail: "tunnel_pending_implementation: configure WireGuard/Tailscale gateway on Home host",
  };
}
