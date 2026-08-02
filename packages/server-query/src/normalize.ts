import {
  LiveServerStateSchema,
  offlineState,
  type LivePlayer,
  type LiveServerState,
} from "@playon/shared";

type GamedigPlayer = {
  name?: string;
  raw?: Record<string, unknown>;
  [key: string]: unknown;
};

type GamedigState = {
  name?: string;
  map?: string;
  password?: boolean;
  numplayers?: number;
  maxplayers?: number;
  players?: GamedigPlayer[];
  version?: string;
  raw?: Record<string, unknown>;
  [key: string]: unknown;
};

function mapPlayers(players: GamedigPlayer[] | undefined): LivePlayer[] | undefined {
  if (!players?.length) return undefined;
  const out: LivePlayer[] = [];
  for (const p of players) {
    const name = typeof p.name === "string" && p.name.trim() ? p.name.trim() : "";
    if (!name) continue;
    const score =
      typeof p.score === "number"
        ? p.score
        : typeof p.raw?.score === "number"
          ? p.raw.score
          : undefined;
    const time =
      typeof p.time === "number"
        ? p.time
        : typeof p.raw?.time === "number"
          ? p.raw.time
          : undefined;
    out.push({
      name,
      ...(score !== undefined ? { score } : {}),
      ...(time !== undefined ? { time } : {}),
      ...(p.raw ? { raw: p.raw } : {}),
    });
  }
  return out.length ? out : undefined;
}

/** Map a GameDig query result into LiveServerState. */
export function fromGamedig(state: GamedigState, queryMs: number, game?: string): LiveServerState {
  const mode =
    typeof state.raw?.gametype === "string"
      ? state.raw.gametype
      : typeof state.raw?.game_type === "string"
        ? state.raw.game_type
        : typeof state.raw?.mode === "string"
          ? state.raw.mode
          : undefined;

  const extras: Record<string, unknown> = {};
  if (state.raw && typeof state.raw === "object") {
    for (const key of ["tags", "queued", "folder", "game", "description"] as const) {
      if (state.raw[key] !== undefined) extras[key] = state.raw[key];
    }
  }

  const mapped: LiveServerState = {
    online: true,
    queryMs,
    ...(state.name ? { name: state.name } : {}),
    ...(game ? { game } : {}),
    ...(state.map ? { map: state.map } : {}),
    ...(mode ? { mode } : {}),
    ...(typeof state.numplayers === "number" ? { players: state.numplayers } : {}),
    ...(typeof state.maxplayers === "number" ? { maxPlayers: state.maxplayers } : {}),
    ...(mapPlayers(state.players) ? { playerList: mapPlayers(state.players) } : {}),
    ...(state.version ? { version: String(state.version) } : {}),
    ...(typeof state.password === "boolean" ? { passwordProtected: state.password } : {}),
    ...(Object.keys(extras).length ? { extras } : {}),
  };
  return LiveServerStateSchema.parse(mapped);
}

export function validateLiveState(raw: unknown, queryMs?: number): LiveServerState {
  const parsed = LiveServerStateSchema.safeParse(raw);
  if (!parsed.success) {
    return offlineState(
      `invalid_live_state: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      queryMs,
    );
  }
  if (queryMs !== undefined && parsed.data.queryMs === undefined) {
    return { ...parsed.data, queryMs };
  }
  return parsed.data;
}

export { offlineState };
