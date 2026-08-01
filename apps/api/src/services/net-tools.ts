import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { URL } from "node:url";
import { resolveInJail } from "@playon/runtime";
import type { ServerService } from "./servers.js";

const MAX_FETCH_BYTES = 25 * 1024 * 1024;

function probePort(host: string, port: number, timeoutMs = 1500): Promise<"open" | "closed"> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result: "open" | "closed") => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done("open"));
    socket.once("timeout", () => done("closed"));
    socket.once("error", () => done("closed"));
  });
}

function canListen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

export class NetToolsService {
  constructor(private readonly servers: ServerService) {}

  async portCheck(args: {
    host?: string;
    port: number;
  }): Promise<{ host: string; port: number; state: "open" | "closed" }> {
    const host = args.host?.trim() || "127.0.0.1";
    const port = Number(args.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("invalid_port");
    }
    const state = await probePort(host, port);
    return { host, port, state };
  }

  async suggestBind(args: {
    preferredPort?: number;
    host?: string;
  }): Promise<{ host: string; port: number; available: boolean }> {
    const host = args.host?.trim() || "0.0.0.0";
    const start = args.preferredPort && Number.isInteger(args.preferredPort) ? args.preferredPort : 25565;
    for (let port = start; port < Math.min(start + 50, 65535); port++) {
      if (await canListen(host === "0.0.0.0" ? "127.0.0.1" : host, port)) {
        return { host, port, available: true };
      }
    }
    return { host, port: start, available: false };
  }

  async fetchUrl(args: {
    serverId: string;
    url: string;
    destPath: string;
  }): Promise<{ path: string; bytes: number; contentType?: string }> {
    const server = await this.servers.get(args.serverId);
    if (!server) throw new Error(`unknown_server: ${args.serverId}`);

    let parsed: URL;
    try {
      parsed = new URL(args.url);
    } catch {
      throw new Error("invalid_url");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported_protocol");
    }

    const target = resolveInJail(server.dataPath, args.destPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });

    const lib = parsed.protocol === "https:" ? https : http;
    const { buffer, contentType } = await new Promise<{
      buffer: Buffer;
      contentType?: string;
    }>((resolve, reject) => {
      const req = lib.get(parsed, { timeout: 30_000 }, (res) => {
        if ((res.statusCode ?? 500) >= 400) {
          reject(new Error(`fetch_failed_${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_FETCH_BYTES) {
            req.destroy();
            reject(new Error("fetch_too_large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({
            buffer: Buffer.concat(chunks),
            contentType: res.headers["content-type"],
          }),
        );
        res.on("error", reject);
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("fetch_timeout"));
      });
    });

    fs.writeFileSync(target, buffer);
    return {
      path: args.destPath,
      bytes: buffer.length,
      contentType,
    };
  }
}
