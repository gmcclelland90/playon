import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import type { LifecycleHttpServer } from "../control-plane-lifecycle.js";

export type FetchApp = { fetch: (req: Request) => Response | Promise<Response> };

export interface ListenEndpoint {
  kind: "http" | "https";
  host: string;
  port: number;
  server: HttpServer | HttpsServer;
}

export interface MultiListenResult {
  /** Composite closer for lifecycle shutdown. */
  composite: LifecycleHttpServer;
  endpoints: ListenEndpoint[];
  /** LAN-facing HTTP port (80 preferred, else fallback). */
  lanPort: number;
  /** Loopback HTTP port for node-agent (always PLAYON_PORT / 8787). */
  loopbackPort: number;
  /** True when LAN bound to the preferred privileged port. */
  privilegedLan: boolean;
  injectWebSocket(inject: (server: HttpServer | HttpsServer) => void): void;
}

function asLifecycle(server: HttpServer | HttpsServer): LifecycleHttpServer {
  return server as unknown as LifecycleHttpServer;
}

function compositeServers(servers: LifecycleHttpServer[]): LifecycleHttpServer {
  if (servers.length === 1) return servers[0]!;
  return {
    close(cb) {
      if (servers.length === 0) {
        cb?.();
        return;
      }
      let remaining = servers.length;
      let firstErr: Error | undefined;
      for (const s of servers) {
        s.close((err?: Error) => {
          if (err && !firstErr) firstErr = err;
          remaining -= 1;
          if (remaining === 0) cb?.(firstErr);
        });
      }
    },
    closeIdleConnections() {
      for (const s of servers) s.closeIdleConnections?.();
    },
    closeAllConnections() {
      for (const s of servers) s.closeAllConnections?.();
    },
  };
}

function listenHttp(
  listener: ReturnType<typeof getRequestListener>,
  host: string,
  port: number,
): Promise<HttpServer> {
  return new Promise((resolve, reject) => {
    const server = createHttpServer(listener);
    const onError = (err: Error) => {
      server.off("listening", onListening);
      try {
        server.close();
      } catch {
        // ignore
      }
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function listenHttps(
  listener: ReturnType<typeof getRequestListener>,
  host: string,
  port: number,
  tls: { key: string | Buffer; cert: string | Buffer },
): Promise<HttpsServer> {
  return new Promise((resolve, reject) => {
    const server = createHttpsServer(tls, listener);
    const onError = (err: Error) => {
      server.off("listening", onListening);
      try {
        server.close();
      } catch {
        // ignore
      }
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export function boundPort(server: HttpServer | HttpsServer): number {
  const addr = server.address() as AddressInfo | null;
  return addr?.port ?? 0;
}

/**
 * Bind LAN HTTP (prefer privileged port) + loopback for node-agent + optional HTTPS.
 */
export async function listenPlayOnHttp(opts: {
  app: FetchApp;
  /** e.g. 0.0.0.0 for LAN, 127.0.0.1 for local-only. */
  lanHost: string;
  /** Preferred LAN port (80 in production). */
  preferredLanPort: number;
  /** Fallback LAN / canonical API port (8787). */
  fallbackPort: number;
  /** Loopback port for node-agent (defaults to fallbackPort). */
  loopbackPort?: number;
  /** Optional TLS for :443 (Discord hostname). */
  tls?: { key: string | Buffer; cert: string | Buffer; port?: number } | null;
}): Promise<MultiListenResult> {
  const listener = getRequestListener((req) => opts.app.fetch(req));
  const loopbackPort = opts.loopbackPort ?? opts.fallbackPort;
  const endpoints: ListenEndpoint[] = [];
  let lanServer: HttpServer | null = null;
  let lanPort = opts.fallbackPort;
  let privilegedLan = false;

  const tryLan = async (port: number) => {
    const server = await listenHttp(listener, opts.lanHost, port);
    lanServer = server;
    lanPort = boundPort(server) || port;
    privilegedLan = port === opts.preferredLanPort && port !== opts.fallbackPort;
    endpoints.push({ kind: "http", host: opts.lanHost, port: lanPort, server });
  };

  try {
    await tryLan(opts.preferredLanPort);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
    if (opts.preferredLanPort !== opts.fallbackPort && (code === "EACCES" || code === "EADDRINUSE")) {
      await tryLan(opts.fallbackPort);
    } else if (opts.preferredLanPort !== opts.fallbackPort) {
      await tryLan(opts.fallbackPort);
    } else {
      throw err;
    }
  }

  // Separate loopback when LAN is not already covering 127.0.0.1:loopbackPort
  const lanCoversLoopback =
    (opts.lanHost === "0.0.0.0" || opts.lanHost === "127.0.0.1" || opts.lanHost === "::") &&
    lanPort === loopbackPort;

  if (!lanCoversLoopback) {
    try {
      const loopServer = await listenHttp(listener, "127.0.0.1", loopbackPort);
      endpoints.push({
        kind: "http",
        host: "127.0.0.1",
        port: boundPort(loopServer) || loopbackPort,
        server: loopServer,
      });
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
      // If loopback port is busy but LAN already listens there via 0.0.0.0, ok; else rethrow
      if (!(code === "EADDRINUSE" && lanPort === loopbackPort && opts.lanHost === "0.0.0.0")) {
        // Non-fatal when LAN fallback already serves the API on loopbackPort via dual-stack
        if (lanPort === loopbackPort && (opts.lanHost === "0.0.0.0" || opts.lanHost === "::")) {
          // covered
        } else {
          throw err;
        }
      }
    }
  }

  if (opts.tls) {
    const tlsPort = opts.tls.port ?? 443;
    try {
      const httpsServer = await listenHttps(listener, opts.lanHost, tlsPort, {
        key: opts.tls.key,
        cert: opts.tls.cert,
      });
      endpoints.push({
        kind: "https",
        host: opts.lanHost,
        port: boundPort(httpsServer) || tlsPort,
        server: httpsServer,
      });
    } catch {
      // TLS bind failure must not brick HTTP Home
    }
  }

  void lanServer; // kept via endpoints
  const composite = compositeServers(endpoints.map((e) => asLifecycle(e.server)));

  return {
    composite,
    endpoints,
    lanPort,
    loopbackPort,
    privilegedLan,
    injectWebSocket(inject) {
      for (const e of endpoints) inject(e.server);
    },
  };
}
