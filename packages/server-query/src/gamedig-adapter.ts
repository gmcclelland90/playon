import { GameDig } from "gamedig";
import { offlineState } from "@playon/shared";
import { fromGamedig } from "./normalize.js";
import type { Connector, QueryTarget } from "./types.js";

export function createGamedigConnector(opts: {
  id: string;
  gamedigType: string;
  /** Prefer queryPort over port when set. */
  useQueryPort?: boolean;
  gameLabel?: string;
}): Connector {
  return {
    id: opts.id,
    async query(target: QueryTarget) {
      const started = Date.now();
      const port =
        opts.useQueryPort && target.queryPort
          ? target.queryPort
          : target.port;
      try {
        const state = await GameDig.query({
          type: opts.gamedigType,
          host: target.host,
          port,
          givenPortOnly: true,
          socketTimeout: target.timeoutMs ?? 2000,
          attemptTimeout: Math.max(target.timeoutMs ?? 2000, 3000),
          maxRetries: 1,
        });
        return fromGamedig(state, Date.now() - started, opts.gameLabel);
      } catch (err) {
        return offlineState(
          err instanceof Error ? err.message : "query_failed",
          Date.now() - started,
        );
      }
    },
  };
}
