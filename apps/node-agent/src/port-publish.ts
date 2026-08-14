import { listenPortProxy, type LivePortProxy, type PortProxyMapping } from "@playon/runtime";
import type { NetPortPublishResult } from "@playon/shared";

type Tracked = LivePortProxy & { serverId: string };

function key(protocol: "tcp" | "udp", listenHost: string, listenPort: number): string {
  return `${protocol}:${listenHost}:${listenPort}`;
}

/**
 * Process-lifetime LAN publish table. Jobs ensure/release; listeners stay up
 * so WSL localhostForwarding on 127.0.0.1 is reachable on the parent join_host.
 */
export class PortPublishRegistry {
  private readonly live = new Map<string, Tracked>();

  list(): Array<PortProxyMapping & { serverId: string }> {
    return [...this.live.values()].map(({ close: _c, ...rest }) => rest);
  }

  async ensure(args: {
    serverId: string;
    listenHost: string;
    listenPort: number;
    protocol: "tcp" | "udp";
    targetHost: string;
    targetPort: number;
  }): Promise<NetPortPublishResult> {
    const k = key(args.protocol, args.listenHost, args.listenPort);
    const existing = this.live.get(k);
    if (
      existing &&
      existing.serverId === args.serverId &&
      existing.targetHost === args.targetHost &&
      existing.targetPort === args.targetPort
    ) {
      return {
        ok: true,
        listening: true,
        action: "ensure",
        serverId: args.serverId,
        listenHost: existing.listenHost,
        listenPort: existing.listenPort,
        protocol: existing.protocol,
        targetHost: existing.targetHost,
        targetPort: existing.targetPort,
      };
    }
    if (existing) {
      existing.close();
      this.live.delete(k);
    }
    try {
      const proxy = await listenPortProxy({
        listenHost: args.listenHost,
        listenPort: args.listenPort,
        protocol: args.protocol,
        targetHost: args.targetHost,
        targetPort: args.targetPort,
      });
      this.live.set(key(proxy.protocol, proxy.listenHost, proxy.listenPort), {
        ...proxy,
        serverId: args.serverId,
      });
      return {
        ok: true,
        listening: true,
        action: "ensure",
        serverId: args.serverId,
        listenHost: proxy.listenHost,
        listenPort: proxy.listenPort,
        protocol: proxy.protocol,
        targetHost: proxy.targetHost,
        targetPort: proxy.targetPort,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : "bind_failed";
      return {
        ok: false,
        listening: false,
        action: "ensure",
        serverId: args.serverId,
        listenHost: args.listenHost,
        listenPort: args.listenPort,
        protocol: args.protocol,
        targetHost: args.targetHost,
        targetPort: args.targetPort,
        error,
      };
    }
  }

  release(args: {
    serverId: string;
    listenPort: number;
    protocol: "tcp" | "udp";
  }): NetPortPublishResult {
    for (const [k, m] of this.live) {
      if (
        m.serverId === args.serverId &&
        m.listenPort === args.listenPort &&
        m.protocol === args.protocol
      ) {
        m.close();
        this.live.delete(k);
      }
    }
    return {
      ok: true,
      listening: false,
      action: "release",
      serverId: args.serverId,
      listenPort: args.listenPort,
      protocol: args.protocol,
    };
  }

  releaseServer(serverId: string): NetPortPublishResult {
    for (const [k, m] of this.live) {
      if (m.serverId === serverId) {
        m.close();
        this.live.delete(k);
      }
    }
    return { ok: true, listening: false, action: "release_server", serverId };
  }

  releaseAll(): void {
    for (const m of this.live.values()) m.close();
    this.live.clear();
  }
}

export const portPublishRegistry = new PortPublishRegistry();
