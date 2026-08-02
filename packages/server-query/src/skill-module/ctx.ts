import dgram from "node:dgram";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { URL } from "node:url";

export type SkillQueryCtx = {
  host: string;
  port: number;
  queryPort: number;
  gamePort: number;
  timeoutMs: number;
  udp: {
    request: (buf: Buffer | Uint8Array, opts?: { port?: number; timeoutMs?: number }) => Promise<Buffer>;
  };
  tcp: {
    request: (
      write: Buffer | Uint8Array | Array<Buffer | Uint8Array>,
      opts?: { port?: number; timeoutMs?: number; readBytes?: number },
    ) => Promise<Buffer>;
  };
  http: {
    get: (path: string, opts?: { port?: number; timeoutMs?: number; https?: boolean }) => Promise<{
      status: number;
      body: string;
    }>;
  };
};

function assertAllowedPort(port: number, allowed: Set<number>): void {
  if (!allowed.has(port)) {
    throw new Error(`port_not_allowed: ${port}`);
  }
}

export function createSkillQueryCtx(opts: {
  host: string;
  port: number;
  queryPort: number;
  gamePort: number;
  timeoutMs: number;
  allowedPorts: number[];
}): SkillQueryCtx {
  const allowed = new Set(opts.allowedPorts.filter((p) => Number.isInteger(p) && p > 0 && p <= 65535));
  allowed.add(opts.port);
  allowed.add(opts.queryPort);
  allowed.add(opts.gamePort);

  return {
    host: opts.host,
    port: opts.port,
    queryPort: opts.queryPort,
    gamePort: opts.gamePort,
    timeoutMs: opts.timeoutMs,
    udp: {
      request(buf, reqOpts) {
        const port = reqOpts?.port ?? opts.queryPort;
        assertAllowedPort(port, allowed);
        const timeoutMs = reqOpts?.timeoutMs ?? opts.timeoutMs;
        const payload = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
        return new Promise((resolve, reject) => {
          const socket = dgram.createSocket("udp4");
          const timer = setTimeout(() => {
            socket.close();
            reject(new Error("udp_timeout"));
          }, timeoutMs);
          socket.once("error", (err) => {
            clearTimeout(timer);
            socket.close();
            reject(err);
          });
          socket.once("message", (msg) => {
            clearTimeout(timer);
            socket.close();
            resolve(msg);
          });
          socket.send(payload, port, opts.host, (err) => {
            if (err) {
              clearTimeout(timer);
              socket.close();
              reject(err);
            }
          });
        });
      },
    },
    tcp: {
      request(write, reqOpts) {
        const port = reqOpts?.port ?? opts.port;
        assertAllowedPort(port, allowed);
        const timeoutMs = reqOpts?.timeoutMs ?? opts.timeoutMs;
        const chunks = Array.isArray(write) ? write : [write];
        const payload = Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))));
        const readBytes = reqOpts?.readBytes ?? 65536;
        return new Promise((resolve, reject) => {
          const socket = net.connect({ host: opts.host, port });
          const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error("tcp_timeout"));
          }, timeoutMs);
          const received: Buffer[] = [];
          let got = 0;
          socket.once("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
          socket.on("data", (chunk) => {
            received.push(chunk);
            got += chunk.length;
            if (got >= readBytes) {
              clearTimeout(timer);
              socket.destroy();
              resolve(Buffer.concat(received).subarray(0, readBytes));
            }
          });
          socket.once("end", () => {
            clearTimeout(timer);
            resolve(Buffer.concat(received));
          });
          socket.once("connect", () => {
            socket.write(payload);
          });
        });
      },
    },
    http: {
      get(path, reqOpts) {
        const port = reqOpts?.port ?? opts.port;
        assertAllowedPort(port, allowed);
        const timeoutMs = reqOpts?.timeoutMs ?? opts.timeoutMs;
        const useHttps = Boolean(reqOpts?.https);
        const url = new URL(`${useHttps ? "https" : "http"}://${opts.host}:${port}${path.startsWith("/") ? path : `/${path}`}`);
        if (url.hostname !== opts.host && url.hostname !== `[${opts.host}]`) {
          return Promise.reject(new Error("host_not_allowed"));
        }
        const lib = useHttps ? https : http;
        return new Promise((resolve, reject) => {
          const req = lib.get(url, { timeout: timeoutMs }, (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (c: Buffer) => {
              size += c.length;
              if (size > 1_000_000) {
                req.destroy();
                reject(new Error("http_body_too_large"));
                return;
              }
              chunks.push(c);
            });
            res.on("end", () => {
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
              });
            });
          });
          req.on("timeout", () => {
            req.destroy();
            reject(new Error("http_timeout"));
          });
          req.on("error", reject);
        });
      },
    },
  };
}
