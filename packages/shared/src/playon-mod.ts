import { z } from "zod";

/** Client-install implication for an authored server mod (panel + agent copy). */
export const ModClientNeedSchema = z.enum(["none", "auto", "manual"]);
export type ModClientNeed = z.infer<typeof ModClientNeedSchema>;

/**
 * PlayOn-owned dialect ids stored in `playon-mod.json`.
 * Hyphenated to match `resolveModDialect` in the API; underscore aliases accepted.
 */
export const PLAYON_MOD_DIALECTS = [
  "project-zomboid",
  "minecraft-paper",
  "rust-oxide",
  "rust-carbon",
  "garrys-mod",
  "terraria-tmod",
  "factorio",
] as const;
export type PlayonModDialect = (typeof PLAYON_MOD_DIALECTS)[number];

const DIALECT_ALIASES: Record<string, PlayonModDialect> = {
  "project-zomboid": "project-zomboid",
  project_zomboid: "project-zomboid",
  "minecraft-paper": "minecraft-paper",
  minecraft_paper: "minecraft-paper",
  paper: "minecraft-paper",
  "rust-oxide": "rust-oxide",
  rust_oxide: "rust-oxide",
  rust: "rust-oxide",
  oxide: "rust-oxide",
  "rust-carbon": "rust-carbon",
  rust_carbon: "rust-carbon",
  carbon: "rust-carbon",
  "garrys-mod": "garrys-mod",
  garrys_mod: "garrys-mod",
  gmod: "garrys-mod",
  "terraria-tmod": "terraria-tmod",
  terraria_tmod: "terraria-tmod",
  tmod: "terraria-tmod",
  factorio: "factorio",
};

/** Normalize a free-form dialect string (skill slug, override, or JSON field). */
export function normalizePlayonModDialect(raw: string): PlayonModDialect | null {
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  if (DIALECT_ALIASES[key]) return DIALECT_ALIASES[key]!;
  const hyphen = key.replace(/_/g, "-");
  return DIALECT_ALIASES[hyphen] ?? null;
}

export const PlayonModDialectSchema = z.string().transform((raw, ctx) => {
  const mapped = normalizePlayonModDialect(raw);
  if (!mapped) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "unknown_mod_dialect" });
    return z.NEVER;
  }
  return mapped;
});

/** PlayOn metadata at `mods-src/<modId>/playon-mod.json` — not a game dialect file. */
export const PlayonModManifestSchema = z.object({
  dialect: PlayonModDialectSchema,
  displayName: z.string().min(1),
  clientNeed: ModClientNeedSchema,
  version: z.string().min(1),
});
export type PlayonModManifest = z.infer<typeof PlayonModManifestSchema>;

export const PLAYON_MOD_JSON = "playon-mod.json";
/** Written under mods-src/<modId>/ after a successful mods_deploy. Not copied live. */
export const PLAYON_DEPLOY_JSON = "playon-deploy.json";
export const MODS_SRC_DIR = "mods-src";
