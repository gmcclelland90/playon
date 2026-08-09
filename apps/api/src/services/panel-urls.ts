/**
 * Panel URL helpers — playon.local, branded HTTPS, and IP fallbacks.
 * Game join addresses stay on advertiseHost (LAN IP); these are admin/player web only.
 */

export const MDNS_HOST = "playon.local";

export function formatHttpUrl(host: string, port: number): string {
  const bare = host.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  if (port === 80) return `http://${bare}`;
  if (port === 443) return `https://${bare}`;
  return `http://${bare}:${port}`;
}

export function formatHttpsUrl(host: string, port = 443): string {
  const bare = host.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  if (port === 443) return `https://${bare}`;
  return `https://${bare}:${port}`;
}

/** Preferred local discovery URL (omit :80). */
export function mdnsPanelUrl(lanPort: number): string {
  return formatHttpUrl(MDNS_HOST, lanPort);
}

export function ipPanelUrl(advertiseHost: string, lanPort: number): string {
  return formatHttpUrl(advertiseHost, lanPort);
}

export interface PanelUrlSet {
  /** Primary LAN discovery URL when mDNS is up. */
  mdnsUrl: string;
  /** Always-available IP (or hostname) fallback. */
  ipUrl: string;
  /** Discord-linked HTTPS panel when configured and healthy. */
  httpsUrl?: string;
  /** Best URL to open in a browser (https > mdns > ip). */
  preferredUrl: string;
  /** All working URLs for banners / Settings (deduped, preferred first). */
  allUrls: string[];
}

export function buildPanelUrls(opts: {
  advertiseHost: string;
  lanPort: number;
  mdnsAdvertised?: boolean;
  publicHostname?: string | null;
  httpsReady?: boolean;
}): PanelUrlSet {
  const mdnsUrl = mdnsPanelUrl(opts.lanPort);
  const ipUrl = ipPanelUrl(opts.advertiseHost, opts.lanPort);
  const httpsUrl =
    opts.httpsReady && opts.publicHostname
      ? formatHttpsUrl(opts.publicHostname)
      : undefined;

  const preferredUrl = httpsUrl ?? (opts.mdnsAdvertised !== false ? mdnsUrl : ipUrl);
  const allUrls: string[] = [];
  const push = (u: string) => {
    if (!allUrls.includes(u)) allUrls.push(u);
  };
  if (httpsUrl) push(httpsUrl);
  if (opts.mdnsAdvertised !== false) push(mdnsUrl);
  push(ipUrl);

  return { mdnsUrl, ipUrl, httpsUrl, preferredUrl, allUrls };
}
