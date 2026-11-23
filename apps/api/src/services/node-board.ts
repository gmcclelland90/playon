import {
  deriveNodePresence,
  LOCAL_NODE_ID,
  LOCAL_WSL_NODE_ID,
  parseUsageHistory,
  placementBadge,
  placementFromNodeKind,
  type NodeKind,
} from "@playon/shared";
import type { ControlPlane } from "../control-plane.js";
import { nodes } from "../db/schema.js";
import { nodeContainers, serverUsageFromInventory } from "./node-inventory.js";
import { getSetting, NODE_SETTINGS_KEY, type NodeSettings } from "./settings.js";
import { alertsForNode } from "./usage-history.js";

/**
 * Operator node inventory. Same payload as `GET /api/nodes`.
 * WireGuard private keys, public keys, raw usage JSON, and the node token
 * itself are never included — only `nodeTokenConfigured`.
 */
export async function listOperatorNodes(plane: ControlPlane) {
  const list = await plane.db.select().from(nodes);
  const now = Date.now();
  const nodeSettings = await getSetting<NodeSettings>(plane.db, NODE_SETTINGS_KEY);
  const nodeServers = await plane.servers.list();
  return {
    localComputeEnabled: nodeSettings?.localComputeEnabled ?? true,
    wireguardTools: plane.tunnel.toolsAvailable(),
    /** True when PLAYON_NODE_TOKEN is set — required to add LAN/cloud nodes. */
    nodeTokenConfigured: Boolean(plane.config.nodeToken?.trim()),
    nodes: list.map((n) => {
      const kind =
        (n.kind as NodeKind) ||
        (n.id === LOCAL_NODE_ID || n.id === LOCAL_WSL_NODE_ID ? "local" : "lan");
      const usageHistory = parseUsageHistory(n.usageHistoryJson);
      const hosted = nodeServers
        .filter((s) => s.nodeId === n.id)
        .map((s) => ({
          id: s.id,
          name: s.name,
          ...serverUsageFromInventory(s.id, s.nodeId, s.runtimeMode),
        }));
      return {
        id: n.id,
        name: n.name,
        os: n.os,
        docker: n.docker,
        native: n.native ?? true,
        steamcmd: n.steamcmd ?? false,
        freeDiskBytes: n.freeDiskBytes,
        cpuPercent: n.cpuPercent,
        memUsedBytes: n.memUsedBytes,
        memTotalBytes: n.memTotalBytes,
        agentVersion: n.agentVersion,
        lastSeenAt: n.lastSeenAt.toISOString(),
        status: deriveNodePresence(n.lastSeenAt, now),
        kind,
        placement: placementFromNodeKind(kind),
        badge: placementBadge({
          kind,
          name: n.name,
          tunnelStatus: n.tunnelStatus,
          nodeId: n.id,
        }),
        tunnelStatus: n.tunnelStatus,
        overlayIp: n.overlayIp,
        tunnelEndpoint: n.tunnelEndpoint,
        joinHost: n.joinHost ?? null,
        containers: nodeContainers(n.id),
        usageHistory: usageHistory.host,
        alerts: alertsForNode({
          nodeId: n.id,
          nodeName: n.name,
          current: n,
          history: usageHistory,
          hostedServers: hosted,
        }),
      };
    }),
  };
}
