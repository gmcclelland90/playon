import fs from "node:fs";
import path from "node:path";

/**
 * Optional lab path to curated games.* trees from the sibling playon-games repo.
 * Product never ships these — hosts install from the playon.games catalog.
 * Override with PLAYON_GAMES_SKILLS_ROOT when the sibling checkout is elsewhere.
 */
export function resolveCatalogGamesRoot(repoRoot: string): string | null {
  const fromEnv = process.env.PLAYON_GAMES_SKILLS_ROOT?.trim();
  if (fromEnv) {
    const abs = path.resolve(fromEnv);
    return fs.existsSync(abs) ? abs : null;
  }
  const sibling = path.join(repoRoot, "..", "playon-games", "skills-src", "games");
  return fs.existsSync(sibling) ? sibling : null;
}

/** Always-available fixture root for unit/int tests (not curated games.*). */
export function resolveFixturesRoot(repoRoot: string): string {
  return path.join(repoRoot, "skills", "fixtures");
}

export const LAB_DOCKER_SKILL = "fixtures.lab-docker-server";
