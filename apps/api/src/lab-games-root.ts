import fs from "node:fs";
import path from "node:path";

/**
 * Optional lab path to curated games.* trees from the sibling playon-games repo.
 * Product never ships these — hosts install from the playon.games catalog.
 * Override with PLAYON_GAMES_SKILLS_ROOT when the sibling checkout is elsewhere.
 * Env var name kept for compat; value can point at packages-src or skills-src tree.
 */
export function resolveCatalogGamesRoot(repoRoot: string): string | null {
  const fromEnv = process.env.PLAYON_GAMES_SKILLS_ROOT?.trim();
  if (fromEnv) {
    const abs = path.resolve(fromEnv);
    return fs.existsSync(abs) ? abs : null;
  }
  // playon-games rename: check packages-src first, fall back to skills-src
  const newPath = path.join(repoRoot, "..", "playon-games", "packages-src", "games");
  if (fs.existsSync(newPath)) return newPath;
  const legacyPath = path.join(repoRoot, "..", "playon-games", "skills-src", "games");
  return fs.existsSync(legacyPath) ? legacyPath : null;
}

/** Always-available fixture root for unit/int tests (not curated games.*). */
export function resolveFixturesRoot(repoRoot: string): string {
  // Phase 4: packages/fixtures (with legacy skills/fixtures fallback)
  const newPath = path.join(repoRoot, "packages", "fixtures");
  const legacyPath = path.join(repoRoot, "skills", "fixtures");
  return fs.existsSync(newPath) ? newPath : legacyPath;
}

export const LAB_DOCKER_SKILL = "fixtures.lab-docker-server";
