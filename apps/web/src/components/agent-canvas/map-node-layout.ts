import { LOCAL_NODE_ID } from "@playon/shared";
import { isPendingNodeSetup } from "../../status";

export type MapNodeInput = {
  id: string;
  name: string;
  kind?: string | null;
  status: string;
  agentVersion?: string | null;
  joinHost?: string | null;
  badge?: string | null;
};

export type MapServerInput = {
  id: string;
  nodeId?: string | null;
};

export type NodeCluster = {
  node: MapNodeInput;
  serverIds: string[];
  /** World origin for this host pad. */
  origin: { x: number; y: number };
};

/** Wider spacing reads better at the pulled-back 2.5D camera. */
const COL_GAP = 480;
const ROW_GAP = 150;
const CRATES_PER_COL = 2;

function kindRank(kind: string | null | undefined): number {
  if (kind === "local" || !kind) return 0;
  if (kind === "lan") return 1;
  if (kind === "cloud") return 2;
  return 3;
}

/** Stable order: Local, LAN, cloud; then name. */
export function sortNodesForMap(nodes: MapNodeInput[]): MapNodeInput[] {
  return [...nodes].sort((a, b) => {
    const kr = kindRank(a.kind) - kindRank(b.kind);
    if (kr !== 0) return kr;
    return a.name.localeCompare(b.name);
  });
}

/**
 * One cluster per node (including empty/pending). Servers without a known nodeId
 * fall under Local when present, else a synthetic bucket.
 */
export function clusterServersByNode(
  nodes: MapNodeInput[],
  servers: MapServerInput[],
): NodeCluster[] {
  const ordered = sortNodesForMap(nodes);
  const byId = new Map(ordered.map((n) => [n.id, n]));
  const buckets = new Map<string, string[]>();
  for (const n of ordered) buckets.set(n.id, []);

  let fallbackId = byId.has(LOCAL_NODE_ID) ? LOCAL_NODE_ID : ordered[0]?.id;
  for (const s of servers) {
    const nid = s.nodeId?.trim() || fallbackId;
    if (!nid) continue;
    if (!buckets.has(nid)) {
      // Orphan server on unknown node — synthesize a pad.
      buckets.set(nid, []);
      if (!byId.has(nid)) {
        byId.set(nid, {
          id: nid,
          name: nid,
          kind: "lan",
          status: "offline",
          agentVersion: null,
        });
      }
    }
    buckets.get(nid)!.push(s.id);
  }

  const ids = [...buckets.keys()].sort((a, b) => {
    const na = byId.get(a)!;
    const nb = byId.get(b)!;
    const kr = kindRank(na.kind) - kindRank(nb.kind);
    if (kr !== 0) return kr;
    return na.name.localeCompare(nb.name);
  });

  const count = Math.max(ids.length, 1);
  const startX = -((count - 1) * COL_GAP) / 2;

  return ids.map((id, index) => ({
    node: byId.get(id)!,
    serverIds: buckets.get(id) ?? [],
    origin: { x: startX + index * COL_GAP, y: -20 },
  }));
}

export function crateOffsetInCluster(indexInCluster: number): { x: number; y: number } {
  const col = indexInCluster % CRATES_PER_COL;
  const row = Math.floor(indexInCluster / CRATES_PER_COL);
  return {
    x: (col - (CRATES_PER_COL - 1) / 2) * 120,
    y: 28 + row * ROW_GAP,
  };
}

export function padPresenceClass(node: MapNodeInput): string {
  if (isPendingNodeSetup({ agentVersion: node.agentVersion, status: node.status })) {
    return "pending_setup";
  }
  return node.status;
}
