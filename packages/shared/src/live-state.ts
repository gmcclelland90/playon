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
