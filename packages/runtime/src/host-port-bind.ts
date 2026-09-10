import { execFileSync } from "node:child_process";
import dgram from "node:dgram";
import net from "node:net";
import type { HostContainer } from "./docker-inventory.js";

export type HostPortNeed = {
  host: number;
  protocol: "tcp" | "udp";
};

export type HostPortHolder = {
  kind: "container" | "process" | "listen" | "time_wait" | "unknown";
  detail: string;
};

/** Real listeners / leftover containers. TIME_WAIT and unnamed leftovers are transient. */
export function isBlockingHostPortHolder(holder: HostPortHolder): boolean {
  return holder.kind === "container" || holder.kind === "process" || holder.kind === "listen";
}

export class HostPortInUseError extends Error {
  readonly port: number;
  readonly protocol: "tcp" | "udp";
  readonly holders: HostPortHolder[];

  constructor(port: number, protocol: "tcp" | "udp", holders: HostPortHolder[]) {
    super(formatHostPortInUseError(port, protocol, holders));
    this.name = "HostPortInUseError";
    this.port = port;
    this.protocol = protocol;
    this.holders = holders;
  }
}

/** Docker / dockerode "failed to bind host port 0.0.0.0:27015/tcp: address already in use". */
export function parseDockerHostPortBindError(err: unknown): HostPortNeed | null {
  const message = err instanceof Error ? err.message : String(err);
  const m = message.match(
    /bind host port\s+\S+:(\d+)\/(tcp|udp):\s*address already in use/i,
  );
  if (!m) return null;
  const host = Number(m[1]);
  if (!Number.isInteger(host) || host < 1 || host > 65535) return null;
  return { host, protocol: m[2]!.toLowerCase() as "tcp" | "udp" };
}

export function formatHostPortInUseError(
  port: number,
  protocol: "tcp" | "udp",
  holders: HostPortHolder[],
): string {
  const who =
    holders.length > 0
      ? holders.map((h) => h.detail).join("; ")
      : "holder unknown (leftover bind or another network namespace)";
  return `host_port_in_use: ${port}/${protocol} held by ${who}`;
}

export function hostPortsFromDockerInspect(info: {
  HostConfig?: { PortBindings?: Record<string, Array<{ HostPort?: string }> | null> | null };
}): HostPortNeed[] {
  const out: HostPortNeed[] = [];
  for (const [key, binds] of Object.entries(info.HostConfig?.PortBindings ?? {})) {
    const m = key.match(/^(\d+)\/(tcp|udp)$/i);
    if (!m) continue;
    const protocol = m[2]!.toLowerCase() as "tcp" | "udp";
    const fallback = Number(m[1]);
    for (const bind of binds ?? []) {
      const host = Number(bind.HostPort || fallback);
      if (Number.isInteger(host) && host >= 1 && host <= 65535) {
        out.push({ host, protocol });
      }
    }
  }
  return out;
}

export function hostPortsFromSpec(
  ports: Array<{ host: number; protocol?: "tcp" | "udp" }> | undefined,
): HostPortNeed[] {
  const out: HostPortNeed[] = [];
  for (const p of ports ?? []) {
    if (!Number.isInteger(p.host) || p.host < 1 || p.host > 65535) continue;
    out.push({ host: p.host, protocol: p.protocol === "udp" ? "udp" : "tcp" });
  }
  return out;
}

function lineMentionsPort(line: string, port: number): boolean {
  return new RegExp(`:${port}(?:\\s|$)`).test(line);
}

function lineMentionsProtocol(line: string, protocol: "tcp" | "udp"): boolean {
  return protocol === "udp" ? /\budp\b/i.test(line) : /\btcp\b/i.test(line);
}

/** Parse `ss -lptun` / `ss -tlnp` process listeners into holders for one port. */
export function holdersFromListenTable(
  output: string,
  port: number,
  protocol: "tcp" | "udp",
): HostPortHolder[] {
  if (!Number.isInteger(port) || port < 1) return [];
  const holders: HostPortHolder[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!lineMentionsPort(line, port)) continue;
    if (!lineMentionsProtocol(line, protocol)) continue;
    const users = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    if (users) {
      holders.push({
        kind: "process",
        detail: `process ${users[1]} pid=${users[2]}`,
      });
      continue;
    }
    const pid = line.match(/\bpid=(\d+)/);
    if (pid) {
      holders.push({ kind: "process", detail: `process pid=${pid[1]}` });
      continue;
    }
    // `ss -p` hides other users' names; a LISTEN/UNCONN line is still a real holder.
    if (/\bLISTEN\b|\bUNCONN\b/i.test(line)) {
      holders.push({
        kind: "listen",
        detail: "listen socket (process hidden)",
      });
    }
  }
  return holders;
}

const TRANSIENT_SOCKET_STATE =
  /\b(?:TIME-WAIT|FIN-WAIT-1|FIN-WAIT-2|CLOSE-WAIT|LAST-ACK|CLOSING|FIN_WAIT|TIME_WAIT)\b/i;

/** Parse `ss -tan` / `ss -uan` for TIME_WAIT leftovers that exclusive bind treats as in-use. */
export function holdersFromSocketTable(
  output: string,
  port: number,
  protocol: "tcp" | "udp",
): HostPortHolder[] {
  if (!Number.isInteger(port) || port < 1) return [];
  const holders: HostPortHolder[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!lineMentionsPort(line, port)) continue;
    if (protocol === "tcp" && /\budp\b/i.test(line) && !/\btcp\b/i.test(line)) continue;
    if (protocol === "udp" && /\btcp\b/i.test(line) && !/\budp\b/i.test(line)) continue;
    const state = line.match(TRANSIENT_SOCKET_STATE)?.[0];
    if (!state) continue;
    holders.push({
      kind: "time_wait",
      detail: `${protocol} ${state.replace(/_/g, "-")} leftover`,
    });
  }
  return holders;
}

export function holdersFromContainers(
  containers: HostContainer[],
  port: number,
  protocol: "tcp" | "udp",
): HostPortHolder[] {
  const holders: HostPortHolder[] = [];
  for (const c of containers) {
    const hit = (c.ports ?? []).some(
      (p) => p.host === port && (!p.protocol || p.protocol === protocol),
    );
    if (!hit) continue;
    const image = c.image ? ` image=${c.image}` : "";
    holders.push({
      kind: "container",
      detail: `container ${c.name}${image}`,
    });
  }
  return holders;
}

export async function tryExclusiveBind(
  port: number,
  protocol: "tcp" | "udp",
  host = "0.0.0.0",
): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (protocol === "udp") return bindUdp(port, host, false);
  return bindTcp(port, host, true);
}

/**
 * Docker userland-proxy binds with SO_REUSEADDR, so TIME_WAIT from a prior
 * matrix skill's port_open/RCON does not block publish. Exclusive bind does.
 */
export async function tryPublishBind(
  port: number,
  protocol: "tcp" | "udp",
  host = "0.0.0.0",
): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (protocol === "udp") return bindUdp(port, host, true);
  return bindTcp(port, host, false);
}

function bindTcp(port: number, host: string, exclusive: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      server.removeAllListeners();
      try {
        server.close(() => resolve(ok));
      } catch {
        resolve(ok);
      }
    };
    server.once("error", () => finish(false));
    try {
      server.listen({ port, host, exclusive }, () => finish(true));
    } catch {
      finish(false);
    }
  });
}

function bindUdp(port: number, host: string, reuseAddr: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      try {
        socket.close(() => resolve(ok));
      } catch {
        resolve(ok);
      }
    };
    socket.once("error", () => finish(false));
    try {
      socket.bind({ port, address: host, exclusive: !reuseAddr }, () => finish(true));
    } catch {
      finish(false);
    }
  });
}

export type HostPortLookup = {
  listContainers?: () => Promise<HostContainer[]>;
  listenTable?: (protocol: "tcp" | "udp") => string | null;
  socketTable?: (protocol: "tcp" | "udp") => string | null;
  tryBind?: (port: number, protocol: "tcp" | "udp") => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
};

export const HOST_PORT_BIND_RETRY = { attempts: 8, delayMs: 350 };

function sleepMs(lookup: HostPortLookup, ms: number): Promise<void> {
  return (lookup.sleep ?? ((wait) => new Promise((resolve) => setTimeout(resolve, wait))))(ms);
}

function uniquePorts(ports: HostPortNeed[]): HostPortNeed[] {
  const seen = new Set<string>();
  const out: HostPortNeed[] = [];
  for (const p of ports) {
    const key = `${p.protocol}:${p.host}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function readSsTable(args: string[]): string | null {
  try {
    return execFileSync("ss", args, {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

export function defaultHostPortLookup(
  listContainers?: () => Promise<HostContainer[]>,
): HostPortLookup {
  return {
    listContainers,
    listenTable: (protocol) => readSsTable(protocol === "udp" ? ["-ulnp"] : ["-tlnp"]),
    socketTable: (protocol) => readSsTable(protocol === "udp" ? ["-uan"] : ["-tan"]),
  };
}

export async function describeHostPortHolders(
  port: number,
  protocol: "tcp" | "udp",
  lookup: HostPortLookup = {},
): Promise<HostPortHolder[]> {
  const holders: HostPortHolder[] = [];
  if (lookup.listContainers) {
    try {
      holders.push(...holdersFromContainers(await lookup.listContainers(), port, protocol));
    } catch {
      /* inventory optional */
    }
  }
  if (lookup.listenTable) {
    try {
      const table = lookup.listenTable(protocol);
      if (table) holders.push(...holdersFromListenTable(table, port, protocol));
    } catch {
      /* ss/netstat optional */
    }
  }
  if (lookup.socketTable) {
    try {
      const table = lookup.socketTable(protocol);
      if (table) holders.push(...holdersFromSocketTable(table, port, protocol));
    } catch {
      /* ss state table optional */
    }
  }
  const seen = new Set<string>();
  return holders.filter((h) => {
    if (seen.has(h.detail)) return false;
    seen.add(h.detail);
    return true;
  });
}

export type HostPortWaitOpts = {
  attempts?: number;
  delayMs?: number;
};

/**
 * Wait out dying docker-proxy / TIME_WAIT / libnetwork leftovers.
 * Returns false when a blocking holder remains; TIME_WAIT-only is treated as free
 * so Docker's SO_REUSEADDR publish can proceed.
 */
export async function waitForHostPortsFree(
  ports: HostPortNeed[],
  lookup: HostPortLookup = {},
  opts: HostPortWaitOpts = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? HOST_PORT_BIND_RETRY.attempts;
  const delayMs = opts.delayMs ?? HOST_PORT_BIND_RETRY.delayMs;
  const tryBind = lookup.tryBind ?? tryPublishBind;
  const needed = uniquePorts(ports);
  if (!needed.length) return true;
  for (let i = 0; i < attempts; i++) {
    let blocked = false;
    let transient = false;
    for (const p of needed) {
      if (await tryBind(p.host, p.protocol)) continue;
      const holders = await describeHostPortHolders(p.host, p.protocol, lookup);
      if (holders.some(isBlockingHostPortHolder)) {
        blocked = true;
        break;
      }
      transient = true;
    }
    if (!blocked && !transient) return true;
    if (blocked) return false;
    if (i < attempts - 1) await sleepMs(lookup, delayMs);
  }
  // Still only TIME_WAIT / unknown leftover — Docker can publish with SO_REUSEADDR.
  return true;
}

export async function assertHostPortsFree(
  ports: HostPortNeed[],
  lookup: HostPortLookup = {},
  opts: HostPortWaitOpts = {},
): Promise<void> {
  const tryBind = lookup.tryBind ?? tryPublishBind;
  for (const p of uniquePorts(ports)) {
    if (await tryBind(p.host, p.protocol)) continue;
    const freed = await waitForHostPortsFree([p], lookup, opts);
    if (freed && (await tryBind(p.host, p.protocol))) continue;
    if (freed) continue;
    const holders = await describeHostPortHolders(p.host, p.protocol, lookup);
    throw new HostPortInUseError(p.host, p.protocol, holders);
  }
}

/**
 * Retry Docker create/start when bind-in-use is only a transient leftover
 * (TIME_WAIT, dying proxy, libnetwork/iptables reservation) — not a live holder.
 */
export async function runWithHostPortBindRetry<T>(
  op: () => Promise<T>,
  lookup: HostPortLookup = {},
  opts: HostPortWaitOpts = {},
): Promise<T> {
  const attempts = opts.attempts ?? HOST_PORT_BIND_RETRY.attempts;
  const delayMs = opts.delayMs ?? HOST_PORT_BIND_RETRY.delayMs;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await op();
    } catch (err) {
      const parsed = parseDockerHostPortBindError(err);
      if (!parsed) throw err;
      const holders = await describeHostPortHolders(parsed.host, parsed.protocol, lookup);
      if (holders.some(isBlockingHostPortHolder)) {
        throw new HostPortInUseError(parsed.host, parsed.protocol, holders);
      }
      lastErr = err;
      if (i < attempts - 1) await sleepMs(lookup, delayMs);
    }
  }
  await rewriteDockerPortBindError(lastErr, lookup);
  throw lastErr;
}

export async function rewriteDockerPortBindError(
  err: unknown,
  lookup: HostPortLookup = {},
): Promise<never> {
  const parsed = parseDockerHostPortBindError(err);
  if (!parsed) throw err;
  const holders = await describeHostPortHolders(parsed.host, parsed.protocol, lookup);
  throw new HostPortInUseError(parsed.host, parsed.protocol, holders);
}
