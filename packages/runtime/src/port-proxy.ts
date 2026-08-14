import dgram from "node:dgram";
import net from "node:net";

export type PortProxyMapping = {
  listenHost: string;
  listenPort: number;
  protocol: "tcp" | "udp";
  targetHost: string;
  targetPort: number;
};

export type LivePortProxy = PortProxyMapping & {
  close: () => void;
};

function listenTcp(mapping: PortProxyMapping): Promise<LivePortProxy> {
  return new Promise((resolve, reject) => {
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
    const fail = (err: Error) => {
      server.close();
      reject(err);
    };
    server.once("error", fail);
    server.listen(mapping.listenPort, mapping.listenHost, () => {
      server.off("error", fail);
      server.on("error", () => {
        /* keep process alive; next ensure reports bind issues */
      });
      const addr = server.address();
      const listenPort =
        addr && typeof addr !== "string" ? addr.port : mapping.listenPort;
      resolve({
        ...mapping,
        listenPort,
        close: () => {
          server.close();
        },
      });
    });
  });
}

function listenUdp(mapping: PortProxyMapping): Promise<LivePortProxy> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const clients = new Map<string, { address: string; port: number }>();
    socket.on("message", (msg, rinfo) => {
      const isFromTarget =
        rinfo.address === mapping.targetHost && rinfo.port === mapping.targetPort;
      if (isFromTarget) {
        const last = [...clients.values()].at(-1);
        if (last) socket.send(msg, last.port, last.address);
        return;
      }
      clients.set(`${rinfo.address}:${rinfo.port}`, {
        address: rinfo.address,
        port: rinfo.port,
      });
      socket.send(msg, mapping.targetPort, mapping.targetHost);
    });
    const fail = (err: Error) => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      reject(err);
    };
    socket.once("error", fail);
    socket.bind(mapping.listenPort, mapping.listenHost, () => {
      socket.off("error", fail);
      socket.on("error", () => undefined);
      resolve({
        ...mapping,
        close: () => {
          try {
            socket.close();
          } catch {
            /* ignore */
          }
          clients.clear();
        },
      });
    });
  });
}

/** Bind a TCP/UDP proxy. Rejects on listen failure (e.g. EADDRINUSE). */
export function listenPortProxy(mapping: PortProxyMapping): Promise<LivePortProxy> {
  return mapping.protocol === "udp" ? listenUdp(mapping) : listenTcp(mapping);
}
