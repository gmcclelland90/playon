import net from "node:net";

/**
 * fetch_url destination policy (#858)
 *
 * Default: block RFC1918, loopback, link-local, ULA, CGNAT, and multicast.
 * Public destinations stay allowed.
 *
 * Exceptions (only these may fetch private space):
 * 1. No hardcoded loopback allowlist — localhost is blocked unless the host
 *    opted that address in via settings. The product does not need implicit
 *    Home loopback (that was a confused-deputy hole).
 * 2. Settings `fetch.lanAllowlist`: RFC1918, IPv6 ULA, or loopback IPs/CIDRs
 *    the host explicitly added (NAS, optional local HTTP).
 *
 * Link-local / metadata (169.254/16, fe80::/10), CGNAT, and multicast cannot
 * be allowlisted. Public IPs do not belong on the list (they are already allowed).
 */

export const FETCH_LAN_ALLOWLIST_MAX = 32;

export type FetchLanCidr = {
  /** Canonical spec stored in settings (single IP has no prefix). */
  spec: string;
  family: "ipv4" | "ipv6";
  addr: bigint;
  bits: number;
};

const IPV4_ALLOW_PARENTS: Array<{ addr: bigint; bits: number }> = [
  { addr: ipv4ToBigInt("10.0.0.0"), bits: 8 },
  { addr: ipv4ToBigInt("172.16.0.0"), bits: 12 },
  { addr: ipv4ToBigInt("192.168.0.0"), bits: 16 },
  { addr: ipv4ToBigInt("127.0.0.0"), bits: 8 },
];

const IPV6_ALLOW_PARENTS: Array<{ addr: bigint; bits: number }> = [
  { addr: ipv6ToBigInt("::1"), bits: 128 },
  { addr: ipv6ToBigInt("fc00::"), bits: 7 },
];

function stripIp(ip: string): string {
  return ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function ipv4ToBigInt(ip: string): bigint {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`fetch_allowlist_invalid: ${ip}`);
  }
  const [a, b, c, d] = parts as [number, number, number, number];
  return BigInt((a << 24) | (b << 16) | (c << 8) | d) & 0xffffffffn;
}

function formatIpv4(addr: bigint): string {
  const n = Number(addr & 0xffffffffn);
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

function splitIpv6Groups(ip: string): number[] {
  if (ip.includes(".")) {
    throw new Error(`fetch_allowlist_invalid: ${ip}`);
  }
  const halves = ip.split("::");
  if (halves.length > 2) throw new Error(`fetch_allowlist_invalid: ${ip}`);
  const parseSide = (side: string | undefined): number[] => {
    if (!side) return [];
    return side.split(":").filter(Boolean).map((g) => {
      if (!/^[0-9a-f]{1,4}$/.test(g)) throw new Error(`fetch_allowlist_invalid: ${ip}`);
      return parseInt(g, 16);
    });
  };
  if (halves.length === 1) {
    const groups = parseSide(halves[0]);
    if (groups.length !== 8) throw new Error(`fetch_allowlist_invalid: ${ip}`);
    return groups;
  }
  const head = parseSide(halves[0]);
  const tail = parseSide(halves[1]);
  const missing = 8 - head.length - tail.length;
  if (missing < 0) throw new Error(`fetch_allowlist_invalid: ${ip}`);
  return [...head, ...Array(missing).fill(0), ...tail];
}

function ipv6ToBigInt(ip: string): bigint {
  const groups = splitIpv6Groups(ip);
  return groups.reduce((acc, g) => (acc << 16n) + BigInt(g), 0n);
}

function formatIpv6(addr: bigint): string {
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) {
    groups.push(((addr >> BigInt(i * 16)) & 0xffffn).toString(16));
  }
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  for (let i = 0; i <= 8; i++) {
    if (i < 8 && groups[i] === "0") {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      const len = i - runStart;
      if (len > bestLen) {
        bestStart = runStart;
        bestLen = len;
      }
      runStart = -1;
    }
  }
  if (bestLen < 2) return groups.join(":");
  const head = groups.slice(0, bestStart).join(":");
  const tail = groups.slice(bestStart + bestLen).join(":");
  return `${head}::${tail}`;
}

function maskBits(addr: bigint, bits: number, width: number): bigint {
  if (bits <= 0) return 0n;
  if (bits >= width) return addr;
  const shift = BigInt(width - bits);
  const mask = ((1n << BigInt(bits)) - 1n) << shift;
  return addr & mask;
}

function cidrContains(
  parent: { addr: bigint; bits: number },
  child: { addr: bigint; bits: number },
  width: number,
): boolean {
  if (child.bits < parent.bits) return false;
  const parentNet = maskBits(parent.addr, parent.bits, width);
  const childNet = maskBits(child.addr, parent.bits, width);
  return parentNet === childNet;
}

function unwrapIpv4Mapped(ip: string): string {
  const v = stripIp(ip);
  if (v.startsWith("::ffff:")) {
    const mapped = v.slice("::ffff:".length);
    if (net.isIPv4(mapped)) return mapped;
  }
  if (net.isIPv6(v) && !net.isIPv4(v)) {
    try {
      const addr = ipv6ToBigInt(v);
      if (addr >> 32n === 0xffffn) return formatIpv4(addr & 0xffffffffn);
    } catch {
      return v;
    }
  }
  return v;
}

/** True if the IP is private, loopback, link-local, or otherwise non-public. */
export function isBlockedDestinationIp(ip: string): boolean {
  const v = unwrapIpv4Mapped(ip);
  if (net.isIPv4(v)) {
    const parts = v.split(".").map((p) => Number(p));
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true;
    if (a !== undefined && a >= 224) return true;
    return false;
  }
  if (net.isIPv6(v)) {
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fc") || v.startsWith("fd")) return true;
    if (v.startsWith("fe80")) return true;
    if (v.startsWith("ff")) return true;
    return false;
  }
  return true;
}

function parseCidrSpec(raw: string): FetchLanCidr {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("fetch_allowlist_invalid: empty");
  const slash = trimmed.lastIndexOf("/");
  let ipPart = trimmed;
  let bits: number | undefined;
  if (slash >= 0) {
    ipPart = trimmed.slice(0, slash);
    const bitsStr = trimmed.slice(slash + 1);
    if (!/^\d+$/.test(bitsStr)) throw new Error(`fetch_allowlist_invalid: ${trimmed}`);
    bits = Number(bitsStr);
  }
  const ip = unwrapIpv4Mapped(ipPart);
  if (net.isIPv4(ip)) {
    const prefix = bits ?? 32;
    if (prefix < 0 || prefix > 32) throw new Error(`fetch_allowlist_invalid: ${trimmed}`);
    const addr = maskBits(ipv4ToBigInt(ip), prefix, 32);
    const spec = prefix === 32 ? formatIpv4(addr) : `${formatIpv4(addr)}/${prefix}`;
    return { spec, family: "ipv4", addr, bits: prefix };
  }
  if (net.isIPv6(ip)) {
    const prefix = bits ?? 128;
    if (prefix < 0 || prefix > 128) throw new Error(`fetch_allowlist_invalid: ${trimmed}`);
    const addr = maskBits(ipv6ToBigInt(ip), prefix, 128);
    const spec = prefix === 128 ? formatIpv6(addr) : `${formatIpv6(addr)}/${prefix}`;
    return { spec, family: "ipv6", addr, bits: prefix };
  }
  throw new Error(`fetch_allowlist_invalid: ${trimmed}`);
}

function isAllowlistableCidr(cidr: FetchLanCidr): boolean {
  const parents = cidr.family === "ipv4" ? IPV4_ALLOW_PARENTS : IPV6_ALLOW_PARENTS;
  const width = cidr.family === "ipv4" ? 32 : 128;
  return parents.some((parent) => cidrContains(parent, cidr, width));
}

function ipMatchesCidr(ip: string, cidr: FetchLanCidr): boolean {
  const v = unwrapIpv4Mapped(ip);
  if (cidr.family === "ipv4") {
    if (!net.isIPv4(v)) return false;
    return cidrContains(cidr, { addr: ipv4ToBigInt(v), bits: 32 }, 32);
  }
  if (!net.isIPv6(v)) return false;
  return cidrContains(cidr, { addr: ipv6ToBigInt(v), bits: 128 }, 128);
}

/**
 * Parse host-provided LAN/loopback CIDRs. Rejects public, link-local, CGNAT,
 * multicast, and hostnames. Returns canonical specs (deduped, stable order).
 */
export function parseFetchLanAllowlist(entries: readonly string[]): string[] {
  return parseFetchLanCidrs(entries).map((c) => c.spec);
}

export function parseFetchLanCidrs(entries: readonly string[]): FetchLanCidr[] {
  if (entries.length > FETCH_LAN_ALLOWLIST_MAX) {
    throw new Error("fetch_allowlist_too_long");
  }
  const out: FetchLanCidr[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    if (typeof raw !== "string") throw new Error("fetch_allowlist_invalid: empty");
    if (!raw.trim()) continue;
    const cidr = parseCidrSpec(raw);
    if (!isAllowlistableCidr(cidr)) {
      throw new Error(`fetch_allowlist_not_private: ${raw.trim()}`);
    }
    if (seen.has(cidr.spec)) continue;
    seen.add(cidr.spec);
    out.push(cidr);
  }
  return out;
}

/** Public IPs are allowed; private IPs only when they match the host allowlist. */
export function isFetchDestinationAllowed(ip: string, allowlist: readonly string[]): boolean {
  if (!isBlockedDestinationIp(ip)) return true;
  let cidrs: FetchLanCidr[];
  try {
    cidrs = parseFetchLanCidrs(allowlist);
  } catch {
    return false;
  }
  return cidrs.some((cidr) => ipMatchesCidr(ip, cidr));
}

export function assertFetchDestinationIp(ip: string, allowlist: readonly string[]): void {
  if (!isFetchDestinationAllowed(ip, allowlist)) {
    throw new Error("fetch_blocked_destination");
  }
}
