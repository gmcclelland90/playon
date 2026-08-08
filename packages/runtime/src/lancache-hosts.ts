import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Markers for the PlayOn-managed hosts block (Steam CDN → LANCache IP). */
export const LANCACHE_HOSTS_BEGIN = "# playon-lancache-begin";
export const LANCACHE_HOSTS_END = "# playon-lancache-end";

/**
 * Concrete Steam CDN hostnames (hosts files do not support wildcards).
 * Full `*.steamcontent.com` coverage needs lancache-dns / DHCP DNS (Slice 2).
 */
export const STEAM_LANCACHE_HOSTS: readonly string[] = [
  "steamcontent.com",
  "lancache.steamcontent.com",
  "steamcdn-a.akamaihd.net",
  "steamcdn-b.akamaihd.net",
  "client-download.steampowered.com",
  "content1.steampowered.com",
  "content2.steampowered.com",
  "content3.steampowered.com",
  "content4.steampowered.com",
  "content5.steampowered.com",
  "content6.steampowered.com",
  "content7.steampowered.com",
  "content8.steampowered.com",
];

export type LancachePinStatus =
  | "applied"
  | "removed"
  | "skipped"
  | "needs_elevation"
  | "error";

export function defaultHostsPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    const root = process.env.SystemRoot?.trim() || "C:\\Windows";
    return path.join(root, "System32", "drivers", "etc", "hosts");
  }
  return "/etc/hosts";
}

function isValidIpv4(ip: string): boolean {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
}

/** Strip any existing PlayOn lancache block from hosts file text. */
export function stripLancacheHostsBlock(content: string): string {
  const begin = content.indexOf(LANCACHE_HOSTS_BEGIN);
  if (begin < 0) return content;
  const end = content.indexOf(LANCACHE_HOSTS_END, begin);
  if (end < 0) {
    return content.slice(0, begin).replace(/\n+$/, "\n");
  }
  const after = end + LANCACHE_HOSTS_END.length;
  const before = content.slice(0, begin);
  const rest = content.slice(after).replace(/^\r?\n/, "");
  return (before.replace(/\n+$/, "\n") + rest).replace(/\n{3,}/g, "\n\n");
}

/** Build the marked hosts block for a cache IP. */
export function buildLancacheHostsBlock(
  cacheIp: string,
  hostnames: readonly string[] = STEAM_LANCACHE_HOSTS,
): string {
  const ip = cacheIp.trim();
  const lines = [
    LANCACHE_HOSTS_BEGIN,
    ...hostnames.map((h) => `${ip}\t${h}`),
    LANCACHE_HOSTS_END,
    "",
  ];
  return lines.join(os.EOL);
}

export function renderHostsWithLancachePin(
  content: string,
  cacheIp: string | null,
  hostnames: readonly string[] = STEAM_LANCACHE_HOSTS,
): string {
  const base = stripLancacheHostsBlock(content).replace(/\s+$/, "") + os.EOL;
  if (!cacheIp?.trim()) return base;
  return base + os.EOL + buildLancacheHostsBlock(cacheIp, hostnames);
}

/**
 * Apply or remove the PlayOn Steam CDN → cacheIp hosts block.
 * When `cacheIp` is null/empty, removes the block only.
 */
export function applyLancacheHostsPin(opts: {
  hostsPath: string;
  cacheIp: string | null;
  hostnames?: readonly string[];
}): { status: LancachePinStatus; detail?: string } {
  const hostnames = opts.hostnames ?? STEAM_LANCACHE_HOSTS;
  const wantPin = Boolean(opts.cacheIp?.trim());
  if (wantPin && !isValidIpv4(opts.cacheIp!)) {
    return { status: "error", detail: "invalid_cache_ip" };
  }

  let existing = "";
  try {
    existing = fs.existsSync(opts.hostsPath) ? fs.readFileSync(opts.hostsPath, "utf8") : "";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      return { status: "needs_elevation", detail: String(code) };
    }
    return { status: "error", detail: err instanceof Error ? err.message : String(err) };
  }

  const next = renderHostsWithLancachePin(existing, wantPin ? opts.cacheIp!.trim() : null, hostnames);
  if (normalizeHostsText(next) === normalizeHostsText(existing)) {
    return { status: wantPin ? "applied" : "removed" };
  }

  try {
    fs.writeFileSync(opts.hostsPath, next, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      return { status: "needs_elevation", detail: String(code) };
    }
    return { status: "error", detail: err instanceof Error ? err.message : String(err) };
  }

  return { status: wantPin ? "applied" : "removed" };
}

function normalizeHostsText(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\s+$/, "\n");
}
