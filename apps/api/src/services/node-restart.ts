/**
 * Home → agent restart without Task Scheduler.
 *
 * The claim loop can be dead while heartbeats still land. A job would sit
 * queued. Piggyback on the next heartbeat ACK so the already-elevated agent
 * exits and PlayOnNodeAgent RestartCount (or systemd) replaces it.
 */

export class NodeRestartService {
  private readonly pending = new Map<string, number>();

  request(nodeId: string, now = Date.now()): void {
    this.pending.set(nodeId, now);
  }

  consume(nodeId: string): boolean {
    if (!this.pending.has(nodeId)) return false;
    this.pending.delete(nodeId);
    return true;
  }

  isPending(nodeId: string): boolean {
    return this.pending.has(nodeId);
  }

  requestedAt(nodeId: string): number | undefined {
    return this.pending.get(nodeId);
  }

  clear(nodeId: string): void {
    this.pending.delete(nodeId);
  }
}

export const nodeRestartService = new NodeRestartService();
