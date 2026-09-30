import { z } from "zod";
import { EXPERIENCE_NAME_PREFIX, assertExperienceName } from "./experience.js";
import { ModClientNeedSchema } from "./playon-mod.js";

/** Default public experiences catalog (sibling of games packages/index.json). */
export const DEFAULT_EXPERIENCES_CATALOG_URL =
  "https://playon.games/packages/experiences/index.json";

/** Site browse route beside /skills (playon-games). Reversible default. */
export const EXPERIENCES_SITE_PATH = "/experiences";

/**
 * Catalog row for a shareable experiences.* zip on playon.games.
 * Separate index from games.* so the skill catalog stays unchanged.
 */
export const CatalogExperienceSchema = z.object({
  name: z
    .string()
    .min(1)
    .refine((n) => n.startsWith(EXPERIENCE_NAME_PREFIX), {
      message: "experience_name_must_use_experiences_prefix",
    }),
  version: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().default(""),
  /** Base title skill (e.g. games.project-zomboid). */
  baseGame: z.string().min(1),
  tags: z.array(z.string()).default([]),
  downloadUrl: z.string().url(),
  sha256: z.string().optional(),
  official: z.boolean().optional(),
  clientNeed: ModClientNeedSchema.optional(),
});
export type CatalogExperience = z.infer<typeof CatalogExperienceSchema>;

export const CatalogExperiencesIndexSchema = z.object({
  updatedAt: z.string().optional(),
  experiences: z.array(CatalogExperienceSchema),
});
export type CatalogExperiencesIndex = z.infer<typeof CatalogExperiencesIndexSchema>;

export const InstallExperienceFromCatalogRequestSchema = z.object({
  serverId: z.string().min(1),
  name: z.string().min(1).optional(),
  downloadUrl: z.string().url().optional(),
});
export type InstallExperienceFromCatalogRequest = z.infer<
  typeof InstallExperienceFromCatalogRequestSchema
>;

/** Build Home deep-link path for Skills → Experiences tab. */
export function experienceInstallDeepLinkPath(name: string): string {
  const n = assertExperienceName(name);
  return `/skills?tab=experiences&name=${encodeURIComponent(n)}`;
}

/**
 * Absolute Install URL for playon.games “Open in Home” buttons.
 * `homeBase` is typically http://playon.local or the host LAN URL.
 */
export function buildExperienceInstallDeepLink(opts: {
  homeBase: string;
  name: string;
}): string {
  const base = opts.homeBase.replace(/\/+$/, "");
  return `${base}${experienceInstallDeepLinkPath(opts.name)}`;
}

/** Suggested public detail path on playon.games (site follow-up). */
export function experienceSiteDetailPath(name: string): string {
  const n = assertExperienceName(name);
  return `${EXPERIENCES_SITE_PATH}/${encodeURIComponent(n)}`;
}

export function resolveExperiencesCatalogUrl(
  envUrl?: string | null,
  storedUrl?: string | null,
): string {
  return envUrl?.trim() || storedUrl?.trim() || DEFAULT_EXPERIENCES_CATALOG_URL;
}
