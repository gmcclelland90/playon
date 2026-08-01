export type NodePresence = "online" | "stale" | "offline";

/** Default: 3× typical 5s heartbeat. */
export const NODE_ONLINE_MS = 15_000;
/** After this, treat the node as fully disconnected. */
export const NODE_OFFLINE_MS = 60_000;

export function deriveNodePresence(
  lastSeenAt: Date | number | string,
  nowMs: number = Date.now(),
  onlineMs: number = NODE_ONLINE_MS,
  offlineMs: number = NODE_OFFLINE_MS,
): NodePresence {
  const seen =
    lastSeenAt instanceof Date
      ? lastSeenAt.getTime()
      : typeof lastSeenAt === "number"
        ? lastSeenAt
        : Date.parse(String(lastSeenAt));
  if (!Number.isFinite(seen)) return "offline";
  const age = nowMs - seen;
  if (age <= onlineMs) return "online";
  if (age <= offlineMs) return "stale";
  return "offline";
}
