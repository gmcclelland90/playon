import { z } from "zod";

export const DEFAULT_UPDATE_MANIFEST_URL = "https://playon.games/home/latest.json";

export const UpdatePlatformSchema = z.enum(["linux-x64", "windows-x64"]);
export type UpdatePlatform = z.infer<typeof UpdatePlatformSchema>;

export const UpdateAssetSchema = z.object({
  downloadUrl: z.string().url(),
  sha256: z.string().min(64).max(64),
  size: z.number().nonnegative().optional(),
});
export type UpdateAsset = z.infer<typeof UpdateAssetSchema>;

export const UpdateManifestSchema = z.object({
  updatedAt: z.string().optional(),
  version: z.string().min(1),
  channel: z.string().default("stable"),
  notesUrl: z.string().url().optional(),
  minHomeVersion: z.string().optional(),
  home: z.object({
    "linux-x64": UpdateAssetSchema.optional(),
    "windows-x64": UpdateAssetSchema.optional(),
  }),
  node: z.object({
    "linux-x64": UpdateAssetSchema.optional(),
    "windows-x64": UpdateAssetSchema.optional(),
  }),
});
export type UpdateManifest = z.infer<typeof UpdateManifestSchema>;

/** Strip leading `v` and parse major.minor.patch (extra suffixes ignored for compare). */
export function coerceSemver(raw: string): { major: number; minor: number; patch: number } | null {
  const cleaned = raw.trim().replace(/^v/i, "");
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(cleaned);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** -1 if a < b, 0 if equal, 1 if a > b. Non-semver strings compare lexicographically after coerce fail. */
export function compareSemver(a: string, b: string): number {
  const pa = coerceSemver(a);
  const pb = coerceSemver(b);
  if (pa && pb) {
    if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
    if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
    if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
    return 0;
  }
  const sa = a.trim().replace(/^v/i, "");
  const sb = b.trim().replace(/^v/i, "");
  if (sa === sb) return 0;
  return sa < sb ? -1 : 1;
}

export function isNewerVersion(latest: string, current: string): boolean {
  return compareSemver(latest, current) > 0;
}

const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "playon.games",
  "www.playon.games",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

/** Validate https + allowlisted host. Returns hostname for callers that need it. */
export function assertAllowedUpdateDownloadUrl(downloadUrl: string): { hostname: string; href: string } {
  const m = /^(https?):\/\/([^/?#]+)(?:[/?#]|$)/i.exec(downloadUrl.trim());
  if (!m) throw new Error("update_download_invalid_url");
  const protocol = m[1].toLowerCase();
  const hostname = m[2].toLowerCase();
  if (protocol !== "https") {
    throw new Error("update_download_https_required");
  }
  if (!ALLOWED_DOWNLOAD_HOSTS.has(hostname)) {
    throw new Error(`update_download_host_not_allowed: ${hostname}`);
  }
  return { hostname, href: downloadUrl.trim() };
}
