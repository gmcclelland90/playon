import { LOCAL_NODE_ID } from "@playon/shared";
import type { NodeContainerRow, ServerRow } from "../../api";
import { displayServerStatus, isPendingNodeSetup, statusLabel } from "../../status";

export type MapNodeInput = {
  id: string;
  name: string;
  kind?: string | null;
  status: string;
  agentVersion?: string | null;
  joinHost?: string | null;
  badge?: string | null;
  cpuPercent?: number | null;
  memUsedBytes?: number | null;
  memTotalBytes?: number | null;
  freeDiskBytes?: number | null;
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

export function inventoryCrateId(nodeId: string, containerName: string): string {
  return `ext:${nodeId}:${containerName}`;
}

export function playonContainerName(serverId: string): string {
  return `playon-${serverId}`;
}

/**
 * Add read-only engine inventory crates that are not already PlayOn servers.
 * Does not create, start, or adopt anything.
 */
export function mergeNodeContainerInventory(
  servers: ServerRow[],
  nodes: Array<{ id: string; containers?: NodeContainerRow[] }>,
): ServerRow[] {
  const extra: ServerRow[] = [];
  const seen = new Set(servers.map((s) => s.id));
  const playonNames = new Set(servers.map((s) => playonContainerName(s.id)));
  const namedOnNode = new Set(
    servers.map((s) => `${s.nodeId ?? ""}:${s.name}`),
  );
  for (const node of nodes) {
    for (const c of node.containers ?? []) {
      if (playonNames.has(c.name)) continue;
      if (namedOnNode.has(`${node.id}:${c.name}`)) continue;
      const id = inventoryCrateId(node.id, c.name);
      if (seen.has(id)) continue;
      seen.add(id);
      extra.push({
        id,
        name: c.name,
        game: c.image,
        nodeId: node.id,
        status: /running/i.test(c.status) ? "running" : "stopped",
        runtimeMode: "docker",
        dataPath: "",
        unmanaged: true,
        ...(c.cpuPercent != null ? { cpuPercent: c.cpuPercent } : {}),
        ...(c.memUsedBytes != null ? { memUsedBytes: c.memUsedBytes } : {}),
      });
    }
  }
  return extra.length ? [...servers, ...extra] : servers;
}

export function padPresenceClass(node: MapNodeInput): string {
  if (isPendingNodeSetup({ agentVersion: node.agentVersion, status: node.status })) {
    return "pending_setup";
  }
  return node.status;
}

/** Player game vs lab canary vs host leftover / sidecar. */
export type BoardCrateKind = "player" | "lab" | "inventory";

/** How a crate is drawn on a crowded host pad. */
export type ClusterCrateRole = "hero" | "player" | "other" | "stack";

export type ClusterCratePlacement = {
  serverId: string;
  offset: { x: number; y: number };
  role: ClusterCrateRole;
  kind: BoardCrateKind | "stack";
  /** Host leftovers / canaries folded into this tile. */
  stackCount?: number;
  stackIds?: string[];
};

/** Collapse side boxes once a host has this many non-player tiles. */
export const OTHER_SERVICES_COLLAPSE_AT = 3;

export function otherServicesStackId(nodeId: string): string {
  return `stack:${nodeId}`;
}

export function otherServicesStackLabel(count: number): string {
  return `${count} other service${count === 1 ? "" : "s"}`;
}

export function isOtherServicesStackId(id: string): boolean {
  return id.startsWith("stack:");
}

function looksLikeDockerImage(game: string): boolean {
  return game.includes("/") || (game.includes(":") && !game.startsWith("games."));
}

function isHelperServiceName(name: string): boolean {
  if (name === "playon-ollama" || name.endsWith("-ollama") || name.includes("ollama")) {
    return true;
  }
  // Expedition park sidecars (discord, spacetime, openvid, stdb, …).
  if (name.startsWith("expedition-")) return true;
  return false;
}

function isLabCanaryName(name: string, game: string): boolean {
  if (name.startsWith("lab-soak-") || name.startsWith("lab-matrix-")) return true;
  if (game.startsWith("fixtures.") || game === "lab") return true;
  return false;
}

/**
 * Inventory leftovers, ollama, Expedition park boxes, and lab canaries must not
 * share visual weight with Small Minecraft / NZL-class player servers.
 */
export function boardCrateKind(server: {
  name: string;
  game?: string | null;
  unmanaged?: boolean;
}): BoardCrateKind {
  if (server.unmanaged) return "inventory";
  const name = server.name.trim().toLowerCase();
  const game = (server.game ?? "").trim().toLowerCase();
  if (looksLikeDockerImage(game) || isHelperServiceName(name)) return "inventory";
  if (isLabCanaryName(name, game)) return "lab";
  return "player";
}

export function isPlayerGameCrate(server: {
  name: string;
  game?: string | null;
  unmanaged?: boolean;
}): boolean {
  return boardCrateKind(server) === "player";
}

/** Join-ready managed game — the tile you actually play. */
export function isHeroCrate(server: {
  name: string;
  game?: string | null;
  unmanaged?: boolean;
  status: string;
  ready?: boolean;
}): boolean {
  return (
    boardCrateKind(server) === "player" &&
    displayServerStatus(server.status, server.ready) === "running"
  );
}

export function boardCrateTone(
  kind: BoardCrateKind,
  shown: string,
): "live" | "idle" | "inventory" | "lab" {
  if (kind === "inventory") return "inventory";
  if (kind === "lab") return "lab";
  return shown === "running" ? "live" : "idle";
}

/**
 * Status under a crate. Inventory must not read as a dead game
 * (“Not joinable”) — those boxes never have a join-path proof.
 */
export function boardCrateStatusText(server: {
  name: string;
  game?: string | null;
  unmanaged?: boolean;
  status: string;
  ready?: boolean;
}): string {
  const kind = boardCrateKind(server);
  if (kind === "inventory") {
    return server.status === "running" ? "On host" : "Host leftover";
  }
  const shown = displayServerStatus(server.status, server.ready);
  if (kind === "lab") {
    if (shown === "running") return "Lab · Running";
    if (shown === "degraded") return "Lab canary";
    return `Lab · ${statusLabel(shown)}`;
  }
  return statusLabel(shown);
}

function playerOffset(index: number): { x: number; y: number } {
  const col = index % CRATES_PER_COL;
  const row = Math.floor(index / CRATES_PER_COL);
  return {
    x: (col - (CRATES_PER_COL - 1) / 2) * 160,
    y: 36 + row * 176,
  };
}

function otherOffset(index: number, playerCount: number): { x: number; y: number } {
  const playerRows = playerCount === 0 ? 0 : Math.ceil(playerCount / CRATES_PER_COL);
  const baseY = 36 + playerRows * 176;
  const col = index % 3;
  const row = Math.floor(index / 3);
  return {
    x: (col - 1) * 88,
    y: baseY + row * 104,
  };
}

function stackOffset(playerCount: number): { x: number; y: number } {
  if (playerCount === 0) return { x: 0, y: 40 };
  if (playerCount % CRATES_PER_COL === 1) return playerOffset(playerCount);
  return otherOffset(0, playerCount);
}

function compareBoardCrates(
  a: ServerRow,
  b: ServerRow,
): number {
  const ha = isHeroCrate(a) ? 0 : 1;
  const hb = isHeroCrate(b) ? 0 : 1;
  if (ha !== hb) return ha - hb;
  return a.name.localeCompare(b.name);
}

/**
 * Place crates on a host pad: running games first and larger; inventory / lab /
 * sidecars to the side, collapsed to one stack when there are many.
 */
export function placeClusterCrates(
  servers: ServerRow[],
  opts: { othersExpanded?: boolean } = {},
): ClusterCratePlacement[] {
  const players = servers.filter(isPlayerGameCrate).sort(compareBoardCrates);
  const others = servers.filter((s) => !isPlayerGameCrate(s)).sort((a, b) => {
    const ka = boardCrateKind(a);
    const kb = boardCrateKind(b);
    if (ka !== kb) return ka === "lab" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const placements: ClusterCratePlacement[] = [];
  players.forEach((server, index) => {
    const hero = isHeroCrate(server);
    placements.push({
      serverId: server.id,
      offset: playerOffset(index),
      role: hero ? "hero" : "player",
      kind: "player",
    });
  });

  const collapse =
    !opts.othersExpanded && others.length >= OTHER_SERVICES_COLLAPSE_AT;
  if (collapse) {
    const nodeId = others[0]?.nodeId?.trim() || "unknown";
    placements.push({
      serverId: otherServicesStackId(nodeId),
      offset: stackOffset(players.length),
      role: "stack",
      kind: "stack",
      stackCount: others.length,
      stackIds: others.map((s) => s.id),
    });
    return placements;
  }

  others.forEach((server, index) => {
    placements.push({
      serverId: server.id,
      offset: otherOffset(index, players.length),
      role: "other",
      kind: boardCrateKind(server),
    });
  });
  return placements;
}

export function clusterPadSize(placements: ClusterCratePlacement[]): {
  w: number;
  h: number;
} {
  if (!placements.length) return { w: 300, h: 170 };
  let maxAbsX = 90;
  let maxY = 90;
  for (const p of placements) {
    const reach = p.role === "hero" ? 70 : p.role === "stack" ? 56 : 48;
    maxAbsX = Math.max(maxAbsX, Math.abs(p.offset.x) + reach);
    maxY = Math.max(maxY, p.offset.y + reach + 36);
  }
  return { w: Math.max(300, maxAbsX * 2 + 72), h: Math.max(170, maxY + 48) };
}
