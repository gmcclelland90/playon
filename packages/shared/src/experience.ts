import { z } from "zod";
import { ModClientNeedSchema, PlayonModDialectSchema } from "./playon-mod.js";

/** Catalog/name prefix for experience packages (sibling of games.* / platform.*). */
export const EXPERIENCE_NAME_PREFIX = "experiences.";

export function assertExperienceName(name: string): string {
  const n = name.trim();
  if (!n.startsWith(EXPERIENCE_NAME_PREFIX) || n.length <= EXPERIENCE_NAME_PREFIX.length) {
    throw new Error(`invalid_experience_name: ${name}`);
  }
  if (!/^experiences\.[a-z0-9][a-z0-9._-]*$/i.test(n)) {
    throw new Error(`invalid_experience_name: ${name}`);
  }
  return n;
}

export const ExperienceModEntrySchema = z.object({
  modId: z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  dialect: PlayonModDialectSchema,
  clientNeed: ModClientNeedSchema.default("none"),
  /** Path inside the zip under mods/ (defaults to mods/<modId>/). */
  path: z.string().min(1).optional(),
});

export const ExperienceOverlaySchema = z.object({
  /** Jail-relative path on the target server (e.g. home/Zomboid/Server/foo.ini). */
  path: z.string().min(1),
  /** utf-8 text content to write (full file replace in v1). */
  content: z.string(),
});

export const ExperiencePanelCopySchema = z.object({
  /** Opaque panel document JSON string (panel_publish compatible). */
  documentJson: z.string().optional(),
  /** Short host-facing blurb for the agent / Mods panel. */
  summary: z.string().optional(),
});

/**
 * Experience package metadata (`metadata.yaml` / `playon-experience.json`).
 * One-click: base game skill reference + authored mods + overlays + optional seed + panel copy.
 */
export const ExperienceManifestSchema = z.object({
  name: z.string().min(1).refine((n) => n.startsWith(EXPERIENCE_NAME_PREFIX), {
    message: "experience_name_must_use_experiences_prefix",
  }),
  version: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().default(""),
  /** Base title skill the experience expects (e.g. games.project-zomboid). */
  baseGame: z.string().min(1),
  mods: z.array(ExperienceModEntrySchema).default([]),
  overlays: z.array(ExperienceOverlaySchema).default([]),
  /** Optional seed / world bootstrap files listed under seed/ in the zip. */
  seedFiles: z.array(z.string()).default([]),
  panel: ExperiencePanelCopySchema.optional(),
  /** Schema version for additive evolution. */
  schemaVersion: z.literal(1).default(1),
});
export type ExperienceManifest = z.infer<typeof ExperienceManifestSchema>;

export const PLAYON_EXPERIENCE_JSON = "playon-experience.json";
