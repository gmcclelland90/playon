import net from "node:net";
import { LiveServerStateSchema, offlineState, type LiveServerState } from "@playon/shared";
import type { Connector, QueryTarget } from "../types.js";

/**
 * Factorio LAN/liveness query.
 *
 * node-gamedig's `factorio` type hits https://multiplayer.factorio.com/… which only
 * works for publicly listed internet servers. PlayOn defaults to LAN visibility,
 * so we probe the RCON TCP port (always bound when the headless server is InGame).
 */
export function probeFactorioRcon(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      done(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      done(false);
    });
  });
}

export const factorioConnector: Connector = {
  id: "factorio",
  async query(target: QueryTarget): Promise<LiveServerState> {
    const started = Date.now();
    const timeoutMs = target.timeoutMs ?? 3000;
    // Prefer dedicated RCON / query port; fall back to game port only as last resort.
    const port = target.queryPort ?? target.port;
    try {
      const open = await probeFactorioRcon(target.host, port, timeoutMs);
      if (!open) {
        return offlineState("factorio_rcon_unreachable", Date.now() - started);
      }
      return LiveServerStateSchema.parse({
        online: true,
        queryMs: Date.now() - started,
        game: "Factorio",
        name: "Factorio",
      });
    } catch (err) {
      return offlineState(
        err instanceof Error ? err.message : "factorio_query_failed",
        Date.now() - started,
      );
    }
  },
};
