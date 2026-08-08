import type { ControlPlane } from "../control-plane.js";

const LOG_RING_MAX = 40;

/** Short per-server log ring for watcher agent context + log_pattern debugging. */
export class WatcherLogBuffer {
  private readonly lines = new Map<string, string[]>();

  push(serverId: string, line: string): void {
    const buf = this.lines.get(serverId) ?? [];
    buf.push(line);
    while (buf.length > LOG_RING_MAX) buf.shift();
    this.lines.set(serverId, buf);
  }

  recent(serverId: string, n = 20): string[] {
    const buf = this.lines.get(serverId) ?? [];
    return buf.slice(-n);
  }
}

export async function buildWatcherContext(
  plane: ControlPlane,
  serverId: string,
  logBuffer: WatcherLogBuffer,
): Promise<Record<string, unknown>> {
  const server = await plane.servers.get(serverId);
  let health: unknown = null;
  try {
    health = await plane.health.checkServer(serverId, { remediate: false });
  } catch (err) {
    health = { error: err instanceof Error ? err.message : "health_failed" };
  }
  let query: unknown = null;
  try {
    query = await plane.queries.queryServer(serverId);
  } catch (err) {
    query = { error: err instanceof Error ? err.message : "query_failed" };
  }
  return {
    server: server
      ? {
          id: server.id,
          name: server.name,
          status: server.status,
          game: server.game,
          nodeId: server.nodeId,
        }
      : { id: serverId, missing: true },
    health,
    query,
    recentLogs: logBuffer.recent(serverId, 20),
  };
}
