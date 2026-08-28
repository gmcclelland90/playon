/**
 * OTA archive download checks shared by Home and node-agent.
 *
 * playon-win-1 0.2.10→0.2.11 hashed bytes that were not the `latest.json`
 * tar.gz (`update_sha256_mismatch`, #917). The advertised digest matched a
 * fresh GitHub `playon-node-*-windows-x64.tar.gz`; the node reported a
 * different digest (not the zip). 0.2.10 only compared sha256 — a 200 HTML,
 * Azure XML, or short body still looked like a checksum miss.
 */

export const UPDATE_DOWNLOAD_SHA_QUERY = "playon_sha256";

export type UpdateArchiveKind = "gzip" | "zip" | "html" | "xml" | "unknown";

/** Pin the GitHub/playon URL to the advertised digest so a cached 302/partial is not reused. */
export function cacheBustUpdateDownloadUrl(downloadUrl: string, sha256: string): string {
  const url = new URL(downloadUrl.trim());
  url.searchParams.set(UPDATE_DOWNLOAD_SHA_QUERY, sha256.toLowerCase());
  return url.href;
}

export function hexMagic(bytes: Uint8Array, n = 2): string {
  const take = Math.min(n, bytes.length);
  let out = "";
  for (let i = 0; i < take; i++) out += bytes[i]!.toString(16).padStart(2, "0");
  return out;
}

export function archiveKindFromBytes(bytes: Uint8Array): UpdateArchiveKind {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return "gzip";
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return "zip";
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, 96))
    .trimStart()
    .toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html")) return "html";
  if (head.startsWith("<?xml") || head.startsWith("<error")) return "xml";
  return "unknown";
}

export function formatUpdateSha256Mismatch(opts: {
  expectedSha256: string;
  gotSha256: string;
  bytes: number;
  expectedBytes?: number;
  kind?: UpdateArchiveKind;
  contentType?: string;
}): string {
  const parts = [
    `update_sha256_mismatch: expected ${opts.expectedSha256} got ${opts.gotSha256}`,
    `bytes=${opts.bytes}`,
  ];
  if (opts.expectedBytes != null) parts.push(`expectedBytes=${opts.expectedBytes}`);
  if (opts.kind) parts.push(`kind=${opts.kind}`);
  if (opts.contentType) parts.push(`contentType=${opts.contentType}`);
  return parts.join(" ");
}

/**
 * Reject HTML/XML/short bodies before apply. Callers still sha256-compare
 * gzip/zip bytes to the advertised digest.
 */
export function assertUpdateArchiveLooksReal(opts: {
  bytes: Uint8Array;
  expectedBytes?: number;
  contentType?: string;
}): UpdateArchiveKind {
  const kind = archiveKindFromBytes(opts.bytes);
  if (opts.expectedBytes != null && opts.bytes.byteLength !== opts.expectedBytes) {
    throw new Error(
      `update_download_size_mismatch: expected ${opts.expectedBytes} got ${opts.bytes.byteLength} kind=${kind}`,
    );
  }
  if (kind !== "gzip" && kind !== "zip") {
    const extra = opts.contentType ? ` contentType=${opts.contentType}` : "";
    throw new Error(
      `update_download_not_archive: kind=${kind} bytes=${opts.bytes.byteLength} magic=${hexMagic(opts.bytes)}${extra}`,
    );
  }
  return kind;
}
