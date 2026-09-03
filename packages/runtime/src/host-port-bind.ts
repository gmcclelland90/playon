import dgram from "node:dgram";
import net from "node:net";
import type { HostContainer } from "./docker-inventory.js";

export type HostPortNeed = {
  host: number;
  protocol: "tcp" | "udp";
};

export type HostPortHolder = {
  kind: "container" | "process" | "unknown";
  detail: string;
};

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

/** Parse `ss -lptun` / `ss -tlnp` process listeners into holders for one port. */
export function holdersFromListenTable(
  output: string,
  port: number,
  protocol: "tcp" | "udp",
): HostPortHolder[] {
  if (!Number.isInteger(port) || port < 1) return [];
  const holders: HostPortHolder[] = [];
  const portRe = new RegExp(`:${port}(?:\\s|$)`);
  const protoRe = protocol === "udp" ? /\budp\b/i : /\btcp\b/i;
  for (const line of output.split(/\r?\n/)) {
    if (!portRe.test(line)) continue;
    if (!protoRe.test(line) && !/LISTEN|UNCONN/i.test(line)) continue;
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
    }
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
  if (protocol === "udp") return exclusiveUdp(port, host);
  return exclusiveTcp(port, host);
}

function exclusiveTcp(port: number, host: string): Promise<boolean> {
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
      server.listen({ port, host, exclusive: true }, () => finish(true));
    } catch {
      finish(false);
    }
  });
}

function exclusiveUdp(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: false });
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
      socket.bind({ port, address: host, exclusive: true }, () => finish(true));
    } catch {
      finish(false);
    }
  });
}

export type HostPortLookup = {
  listContainers?: () => Promise<HostContainer[]>;
  listenTable?: (protocol: "tcp" | "udp") => string | null;
};

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
  const seen = new Set<string>();
  return holders.filter((h) => {
    if (seen.has(h.detail)) return false;
    seen.add(h.detail);
    return true;
  });
}

export async function assertHostPortsFree(
  ports: HostPortNeed[],
  lookup: HostPortLookup = {},
): Promise<void> {
  const seen = new Set<string>();
  for (const p of ports) {
    const key = `${p.protocol}:${p.host}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const free = await tryExclusiveBind(p.host, p.protocol);
    if (free) continue;
    const holders = await describeHostPortHolders(p.host, p.protocol, lookup);
    throw new HostPortInUseError(p.host, p.protocol, holders);
  }
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
