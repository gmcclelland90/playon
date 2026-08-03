import { z } from "zod";

export const LivePlayerSchema = z.object({
  name: z.string().min(1),
  score: z.number().optional(),
  time: z.number().optional(),
  raw: z.record(z.unknown()).optional(),
});

export type LivePlayer = z.infer<typeof LivePlayerSchema>;

/** Normalized live query result — connectors omit unknowns rather than inventing values. */
export const LiveServerStateSchema = z.object({
  online: z.boolean(),
  queryMs: z.number().nonnegative().optional(),
  name: z.string().optional(),
  game: z.string().optional(),
  map: z.string().optional(),
  mode: z.string().optional(),
  players: z.number().int().nonnegative().optional(),
  maxPlayers: z.number().int().nonnegative().optional(),
  playerList: z.array(LivePlayerSchema).optional(),
  version: z.string().optional(),
  passwordProtected: z.boolean().optional(),
  uptimeSeconds: z.number().nonnegative().optional(),
  extras: z.record(z.unknown()).optional(),
  /** Agent-facing failure detail; prefer omitting from public panel copy. */
  error: z.string().optional(),
});

export type LiveServerState = z.infer<typeof LiveServerStateSchema>;

export function offlineState(error: string, queryMs?: number): LiveServerState {
  return {
    online: false,
    ...(queryMs !== undefined ? { queryMs } : {}),
    error,
  };
}

/**
 * Keys on server_status.body owned by the live-query layer.
 * Control plane always re-applies these so agent panel_publish cannot wipe them.
 */
export const LIVE_PANEL_STATUS_KEYS = [
  "online",
  "players",
  "maxPlayers",
  "map",
  "mode",
  "serverName",
  "version",
  "uptimeSeconds",
  "playerList",
] as const;

export type LivePanelStatusKey = (typeof LIVE_PANEL_STATUS_KEYS)[number];

/** Single LiveServerState → player panel server_status.body projection. */
export function liveStateToPanelBody(live?: LiveServerState | null): Record<string, unknown> {
  if (!live?.online) return {};
  const out: Record<string, unknown> = { online: true };
  if (live.players !== undefined) out.players = live.players;
  if (live.maxPlayers !== undefined) out.maxPlayers = live.maxPlayers;
  if (live.map) out.map = live.map;
  if (live.mode) out.mode = live.mode;
  if (live.name) out.serverName = live.name;
  if (live.version) out.version = live.version;
  if (live.uptimeSeconds !== undefined) out.uptimeSeconds = live.uptimeSeconds;
  if (live.playerList?.length) {
    out.playerList = live.playerList.map((p) => ({
      name: p.name,
      ...(p.score !== undefined ? { score: p.score } : {}),
    }));
  }
  return out;
}
