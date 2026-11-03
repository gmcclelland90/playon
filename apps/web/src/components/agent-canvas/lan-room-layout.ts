import type { PanelBlockRow } from "../../api";

/** Who is on a game server, from its live `server_status` panel block. */
export type ServerPlayers = {
  count: number;
  max?: number;
  names: string[];
};

function toCount(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/** Live player lists arrive as names or as `{ name }` rows from the query connectors. */
function playerName(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry.trim() || undefined;
  if (entry && typeof entry === "object" && "name" in entry) {
    const name = (entry as { name?: unknown }).name;
    return typeof name === "string" && name.trim() ? name.trim() : undefined;
  }
  return undefined;
}

/** Player counts per server id. Servers without a live status block are left out. */
export function serverPlayersFromPanel(blocks: PanelBlockRow[]): Record<string, ServerPlayers> {
  const out: Record<string, ServerPlayers> = {};
  for (const block of blocks) {
    if (block.type !== "server_status" || !block.serverId) continue;
    const names = Array.isArray(block.body.playerList)
      ? block.body.playerList.map(playerName).filter((n): n is string => Boolean(n))
      : [];
    const count = toCount(block.body.players) ?? (names.length ? names.length : undefined);
    if (count === undefined) continue;
    const max = toCount(block.body.maxPlayers);
    out[block.serverId] = { count, ...(max !== undefined ? { max } : {}), names };
  }
  return out;
}

/** Seats drawn around a station. Past the cap the last seat reads "+N". */
export const MAX_SEATS = 8;

export type Seat = { key: string; label: string; title: string; overflow?: boolean };

export function stationSeats(players: ServerPlayers | undefined): Seat[] {
  if (!players || players.count <= 0) return [];
  const seats: Seat[] = [];
  const shown = players.count > MAX_SEATS ? MAX_SEATS - 1 : players.count;
  for (let i = 0; i < shown; i++) {
    const name = players.names[i];
    seats.push({
      key: name ? `p:${name}:${i}` : `p:${i}`,
      label: name ? name.slice(0, 1).toUpperCase() : "",
      title: name ?? "Player",
    });
  }
  if (players.count > shown) {
    const rest = players.count - shown;
    seats.push({ key: "more", label: `+${rest}`, title: `${rest} more`, overflow: true });
  }
  return seats;
}

export type Box = { x: number; y: number; w: number; h: number };
export type Point = { x: number; y: number };

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Where the LAN switch sits: the middle of the tables, so cables fan out to each one.
 * If that lands on a table (one row of three, say), it drops below the tables instead.
 * Fewer than two tables need no switch.
 */
export function switchSpot(tables: Box[], size: number, gap = 24): Point | null {
  if (tables.length < 2) return null;
  const centers = tables.map((t) => ({ x: t.x + t.w / 2, y: t.y + t.h / 2 }));
  const x = centers.reduce((sum, c) => sum + c.x, 0) / centers.length;
  const y = centers.reduce((sum, c) => sum + c.y, 0) / centers.length;
  const half = size / 2;
  const box = { x: x - half - gap / 2, y: y - half - gap / 2, w: size + gap, h: size + gap };
  if (!tables.some((t) => overlaps(box, t))) return { x, y };
  const bottom = Math.max(...tables.map((t) => t.y + t.h));
  return { x, y: bottom + gap + half };
}
