import { useEffect, useRef, useState } from "react";
import { playonSocket } from "../ws";

/** Seed from REST snapshot once per server, then append live `server.log` lines. */
export function useServerLiveLogs(serverId: string | undefined, seed: string[] | undefined) {
  const [lines, setLines] = useState<string[]>([]);
  const [liveStatus, setLiveStatus] = useState<string | undefined>();
  const seededFor = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!serverId) {
      setLines([]);
      setLiveStatus(undefined);
      seededFor.current = undefined;
      return;
    }
    if (seededFor.current !== serverId) {
      seededFor.current = serverId;
      setLines(seed ?? []);
      setLiveStatus(undefined);
      return;
    }
    if ((seed?.length ?? 0) > 0 && lines.length === 0) {
      setLines(seed ?? []);
    }
  }, [serverId, seed, lines.length]);

  useEffect(() => {
    if (!serverId) return;
    return playonSocket.subscribe((event) => {
      if (event.type === "server.log" && event.serverId === serverId) {
        setLines((prev) => {
          const next = [...prev, event.line];
          return next.length > 500 ? next.slice(-500) : next;
        });
      }
      if (event.type === "server.status" && event.serverId === serverId) {
        setLiveStatus(event.status);
      }
    });
  }, [serverId]);

  return { lines, liveStatus };
}
