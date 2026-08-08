import { z } from "zod";

/**
 * Request contracts for the skill-library routes. They live here rather than
 * inline in `app.ts` so the control plane and web client validate the same
 * shape, and so a schema failure renders as the shared 400 envelope.
 */

/**
 * Either identifier is enough: `name` resolves through the catalog, a
 * `downloadUrl` installs a package the catalog listed elsewhere. The route
 * still rejects a body with neither, so the caller keeps the
 * `name_or_downloadUrl_required` text instead of a generic schema failure.
 */
export const InstallSkillFromCatalogRequestSchema = z.object({
  name: z.string().min(1).optional(),
  downloadUrl: z.string().url().optional(),
  overwrite: z.boolean().optional(),
});

export type InstallSkillFromCatalogRequest = z.infer<typeof InstallSkillFromCatalogRequestSchema>;

/** JSON alternative to the multipart upload on `POST /api/skills/import`. */
export const ImportSkillZipRequestSchema = z.object({
  zipBase64: z.string().min(1),
  overwrite: z.boolean().optional(),
});

export type ImportSkillZipRequest = z.infer<typeof ImportSkillZipRequestSchema>;

export const PromoteServerSkillRequestSchema = z.object({
  serverId: z.string().min(1),
  skillSlug: z.string().min(1),
  overwrite: z.boolean().optional(),
});

export type PromoteServerSkillRequest = z.infer<typeof PromoteServerSkillRequestSchema>;

/** Servers still bound to a skill, returned as `details` on the 409 uninstall. */
export const SkillInUseDetailsSchema = z.object({
  servers: z.array(z.object({ id: z.string(), name: z.string() })),
});

export type SkillInUseDetails = z.infer<typeof SkillInUseDetailsSchema>;

export function skillInUseServers(details: unknown): Array<{ id: string; name: string }> {
  const parsed = SkillInUseDetailsSchema.safeParse(details);
  return parsed.success ? parsed.data.servers : [];
}
