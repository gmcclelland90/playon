/**
 * Home LAN gateway: advertise local ports that forward TCP/UDP to cloud overlay IPs.
 */
import dgram from "node:dgram";
import net from "node:net";
import type { AppConfig } from "../../config.js";

export type GatewayMapping = {
  serverId: string;
  nodeId: string;
  /** Port bound on Home (LAN-facing). */
  listenPort: number;
  protocol: "tcp" | "udp";
  /** Cloud node overlay IP. */
  targetHost: string;
  targetPort: number;
};

type LiveMapping = GatewayMapping & {
  close: () => void;
};

export class LanGateway {
  private readonly live = new Map<string, LiveMapping>();

  constructor(private readonly config: AppConfig) {}

  private key(m: Pick<GatewayMapping, "listenPort" | "protocol">): string {
    return `${m.protocol}:${m.listenPort}`;
  }

  list(): GatewayMapping[] {
    return [...this.live.values()].map(({ close: _c, ...rest }) => rest);
  }

  /** Ensure a mapping exists; replaces any prior mapping on the same listen port/protocol. */
  async ensure(mapping: GatewayMapping): Promise<GatewayMapping> {
    const k = this.key(mapping);
    const existing = this.live.get(k);
    if (
      existing &&
      existing.targetHost === mapping.targetHost &&
      existing.targetPort === mapping.targetPort &&
      existing.serverId === mapping.serverId
    ) {
      return existing;
    }
    if (existing) existing.close();

    const close =
      mapping.protocol === "tcp"
        ? this.listenTcp(mapping)
        : this.listenUdp(mapping);

    const live: LiveMapping = { ...mapping, close };
    this.live.set(k, live);
    return mapping;
  }

  async releaseServer(serverId: string): Promise<void> {
    for (const [k, m] of this.live) {
      if (m.serverId === serverId) {
        m.close();
        this.live.delete(k);
      }
    }
  }

  async releaseAll(): Promise<void> {
    for (const m of this.live.values()) m.close();
    this.live.clear();
  }

  advertiseHost(): string {
    return this.config.advertiseHost;
  }

  private listenTcp(mapping: GatewayMapping): () => void {
    const server = net.createServer((client) => {
      const upstream = net.connect(mapping.targetPort, mapping.targetHost);
      client.pipe(upstream);
      upstream.pipe(client);
      const kill = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on("error", kill);
      upstream.on("error", kill);
    });
    server.listen(mapping.listenPort, "0.0.0.0");
    server.on("error", () => {
      /* bind failures surface on next ensure */
    });
    return () => {
      server.close();
    };
  }

  private listenUdp(mapping: GatewayMapping): () => void {
    const socket = dgram.createSocket("udp4");
    /** Map client "ip:port" → last seen for reply routing. */
    const clients = new Map<string, { address: string; port: number }>();

    socket.on("message", (msg, rinfo) => {
      const isFromTarget =
        rinfo.address === mapping.targetHost && rinfo.port === mapping.targetPort;
      if (isFromTarget) {
        // Reply to most recent LAN client (typical single-player / query pattern).
        const last = [...clients.values()].at(-1);
        if (last) socket.send(msg, last.port, last.address);
        return;
      }
      const ck = `${rinfo.address}:${rinfo.port}`;
      clients.set(ck, { address: rinfo.address, port: rinfo.port });
      socket.send(msg, mapping.targetPort, mapping.targetHost);
    });

    socket.bind(mapping.listenPort, "0.0.0.0");
    return () => {
      try {
        socket.close();
      } catch {
        // ignore
      }
      clients.clear();
    };
  }
}
