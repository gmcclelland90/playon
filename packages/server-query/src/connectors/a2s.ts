import { offlineState, type LiveServerState } from "@playon/shared";
import { createGamedigConnector } from "../gamedig-adapter.js";
import type { Connector, QueryTarget } from "../types.js";
import { a2sInfoExchange, liveStateFromA2s, parseA2sInfo, uniqueA2sPorts } from "./a2s-info.js";

export function a2sQueryPorts(target: QueryTarget): number[] {
  return uniqueA2sPorts(target.port, target.queryPort, target.gamePort);
}

/**
 * Valve A2S via GameDig, then a same-socket native challenge exchange.
 * GameDig `Failed all 3 attempts` is common through Docker userland-proxy
 * (UDP 5-tuple rewrite). Native fallback keeps the advertised host/port.
 */
export function createA2sConnector(opts?: { gamedig?: Connector }): Connector {
  const gamedig =
    opts?.gamedig ??
    createGamedigConnector({
      id: "a2s",
      gamedigType: "protocol-valve",
      gameLabel: "Source",
    });

  return {
    id: "a2s",
    async query(target: QueryTarget): Promise<LiveServerState> {
      const started = Date.now();
      const gamedigState = await gamedig.query(target);
      if (gamedigState.online) return gamedigState;

      const timeoutMs = target.timeoutMs ?? 2500;
      const ports = a2sQueryPorts(target);
      const perTry = Math.max(400, Math.floor(timeoutMs / Math.max(1, ports.length)));
      for (const port of ports) {
        try {
          const reply = await a2sInfoExchange(target.host, port, perTry);
          return liveStateFromA2s(parseA2sInfo(reply), Date.now() - started);
        } catch {
          // next port
        }
      }
      return gamedigState.online === false
        ? gamedigState
        : offlineState(gamedigState.error ?? "a2s_query_failed", Date.now() - started);
    },
  };
}

export const a2sConnector = createA2sConnector();
