import type { PanelBlockRow } from "./api";

export type ServerPanelGroup = {
  key: string;
  serverId: string | null;
  join: PanelBlockRow | undefined;
  status: PanelBlockRow | undefined;
  /** Non-join, non-status blocks for this server (setup, guides, votes, …). */
  rest: PanelBlockRow[];
};

function joinEndpoint(body: Record<string, unknown>): string | null {
  const address = typeof body.address === "string" ? body.address.trim() : "";
  const port = typeof body.port === "number" ? body.port : Number(body.port);
  if (address && Number.isFinite(port)) return `${address}:${port}`;
  if (typeof body.endpoint === "string" && body.endpoint.trim()) return body.endpoint.trim();
  if (address) return address;
  return null;
}

/** Prefer join_info that includes an explicit port (game port), newest sortOrder wins ties. */
export function pickJoinBlock(blocks: PanelBlockRow[]): PanelBlockRow | undefined {
  const joins = blocks.filter((b) => b.type === "join_info");
  if (!joins.length) return undefined;
  const scored = [...joins].sort((a, b) => {
    const portA = typeof a.body.port === "number" ? a.body.port : Number(a.body.port);
    const portB = typeof b.body.port === "number" ? b.body.port : Number(b.body.port);
    const aHas = Number.isFinite(portA) ? 1 : 0;
    const bHas = Number.isFinite(portB) ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas;
    return (b.sortOrder ?? 0) - (a.sortOrder ?? 0);
  });
  return scored[0];
}

function isEchoOnlySetup(block: PanelBlockRow, join: string | null): boolean {
  if (block.type !== "client_setup") return false;
  const notes = typeof block.body.notes === "string" ? block.body.notes.trim() : "";
  if (!join || !notes) return false;
  return (
    notes === join ||
    notes === `Connect to ${join}` ||
    notes === `Connect to ${join} (native).` ||
    notes === `Connect to ${join} (${String(block.body.runtime ?? "native")}).`
  );
}

function groupKey(serverId: string | null | undefined): string {
  return serverId ?? "__general__";
}

/**
 * Group panel blocks by serverId. Each group with a join_info is a live server section.
 * Null-serverId blocks form a "General" group.
 */
export function groupPanelByServer(blocks: PanelBlockRow[]): ServerPanelGroup[] {
  const byKey = new Map<string, PanelBlockRow[]>();
  for (const block of blocks) {
    const key = groupKey(block.serverId);
    const list = byKey.get(key) ?? [];
    list.push(block);
    byKey.set(key, list);
  }

  const groups: ServerPanelGroup[] = [];
  for (const [key, groupBlocks] of byKey) {
    const join = pickJoinBlock(groupBlocks);
    const joinEp = join ? joinEndpoint(join.body) : null;
    const status = groupBlocks.find((b) => b.type === "server_status");
    const rest = groupBlocks
      .filter((b) => {
        if (b.type === "join_info") return false;
        if (b.type === "server_status") return false;
        if (isEchoOnlySetup(b, joinEp)) return false;
        return true;
      })
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

    groups.push({
      key,
      serverId: key === "__general__" ? null : key,
      join,
      status,
      rest,
    });
  }

  return groups.sort((a, b) => {
    const aHasJoin = a.join ? 1 : 0;
    const bHasJoin = b.join ? 1 : 0;
    if (aHasJoin !== bHasJoin) return bHasJoin - aHasJoin;

    const statusA = typeof a.status?.body.status === "string" ? a.status.body.status : "";
    const statusB = typeof b.status?.body.status === "string" ? b.status.body.status : "";
    const aRunning = statusA === "running" ? 1 : 0;
    const bRunning = statusB === "running" ? 1 : 0;
    if (aRunning !== bRunning) return bRunning - aRunning;

    const orderA = a.join?.sortOrder ?? 0;
    const orderB = b.join?.sortOrder ?? 0;
    if (orderA !== orderB) return orderA - orderB;

    const titleA = a.join?.title ?? "";
    const titleB = b.join?.title ?? "";
    return titleA.localeCompare(titleB);
  });
}

export { joinEndpoint };
