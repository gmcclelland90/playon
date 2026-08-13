import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { URL } from "node:url";
import { assertFetchDestinationIp, parseFetchLanAllowlist } from "./fetch-destination.js";
import type { ServerService } from "./servers.js";

export { isBlockedDestinationIp } from "./fetch-destination.js";

export type FetchLanAllowlistLoader = () => Promise<readonly string[]>;

const MAX_FETCH_BYTES = 100 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;

const DENIED_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-connection",
]);

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

async function assertAllowedFetchHost(parsed: URL, allowlist: readonly string[]): Promise<void> {
  const hostname = parsed.hostname;
  if (!hostname) throw new Error("invalid_url");

  if (net.isIP(hostname)) {
    assertFetchDestinationIp(hostname, allowlist);
    return;
  }

  let addresses: string[];
  try {
    const results = await dns.lookup(hostname, { all: true, verbatim: true });
    addresses = results.map((r) => r.address);
  } catch {
    throw new Error("fetch_dns_failed");
  }
  if (addresses.length === 0) throw new Error("fetch_dns_failed");
  for (const addr of addresses) {
    assertFetchDestinationIp(addr, allowlist);
  }
}

function sanitizeHeaders(input?: Record<string, string>): Record<string, string> {
  if (!input) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const name = key.trim();
    if (!name || DENIED_HEADERS.has(name.toLowerCase())) continue;
    if (typeof value !== "string") continue;
    out[name] = value;
  }
  return out;
}

function parseUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("invalid_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("unsupported_protocol");
  }
  return parsed;
}

export class NetToolsService {
  constructor(
    private readonly servers: ServerService,
    private readonly getLanAllowlist?: FetchLanAllowlistLoader,
  ) {}

  private async lanAllowlist(): Promise<readonly string[]> {
    const raw = (await this.getLanAllowlist?.()) ?? [];
    try {
      return parseFetchLanAllowlist(raw);
    } catch {
      return [];
    }
  }

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
    headers?: Record<string, string>;
  }): Promise<{ path: string; bytes: number; contentType?: string; finalUrl: string }> {
    const store = await this.servers.files(args.serverId);

    const headers = sanitizeHeaders(args.headers);
    let current = parseUrl(args.url);
    let redirects = 0;

    const allowlist = await this.lanAllowlist();
    while (true) {
      await assertAllowedFetchHost(current, allowlist);
      const result = await this.downloadOnce(current, headers);
      if (result.kind === "redirect") {
        redirects += 1;
        if (redirects > MAX_REDIRECTS) throw new Error("fetch_too_many_redirects");
        current = parseUrl(new URL(result.location, current).toString());
        continue;
      }

      const written = await store.writeBytes(args.destPath, result.buffer);
      return {
        path: written.path,
        bytes: written.bytes,
        contentType: result.contentType,
        finalUrl: current.toString(),
      };
    }
  }

  private downloadOnce(
    parsed: URL,
    headers: Record<string, string>,
  ): Promise<
    | { kind: "ok"; buffer: Buffer; contentType?: string }
    | { kind: "redirect"; location: string }
  > {
    const lib = parsed.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.get(
        parsed,
        {
          timeout: FETCH_TIMEOUT_MS,
          headers: {
            ...headers,
            Accept: headers.Accept ?? headers.accept ?? "*/*",
          },
        },
        (res) => {
          const status = res.statusCode ?? 500;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            resolve({ kind: "redirect", location: res.headers.location });
            return;
          }
          if (status >= 400) {
            res.resume();
            reject(new Error(`fetch_failed_${status}`));
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
              kind: "ok",
              buffer: Buffer.concat(chunks),
              contentType: res.headers["content-type"],
            }),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("fetch_timeout"));
      });
    });
  }
}
