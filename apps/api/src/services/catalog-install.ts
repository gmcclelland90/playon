import type { AppConfig } from "../config.js";
import type { SkillPackageService } from "./skill-packages.js";
import {
  downloadCatalogSkillZip,
  fetchSkillsCatalog,
  findCatalogSkill,
  type CatalogSkill,
} from "./skills-catalog.js";
import { listSkills, loadSkillMetadata } from "./skills.js";

export type CatalogInstallResult = {
  skillName: string;
  path: string;
  version: string;
  catalogUrl: string;
  downloadUrl: string;
  sha256: string;
  official?: boolean;
  /** Skills installed in this call (primary first, then missing catalog deps). */
  installed: string[];
  /** Dependencies already present locally (skipped). */
  skippedDeps: string[];
};

const MAX_DEP_DEPTH = 4;

export async function installSkillFromCatalog(opts: {
  config: AppConfig;
  skillPackages: SkillPackageService;
  catalogUrl: string;
  name?: string;
  downloadUrl?: string;
  overwrite?: boolean;
  fetchCatalog?: (url: string) => Promise<CatalogSkill[]>;
  downloadZip?: (
    downloadUrl: string,
    expectedSha256?: string,
  ) => Promise<{ bytes: Uint8Array; sha256: string }>;
}): Promise<CatalogInstallResult> {
  const name = opts.name?.trim() || "";
  const downloadUrl = opts.downloadUrl?.trim() || "";
  if (!name && !downloadUrl) {
    throw new Error("skill_install_requires_name_or_downloadUrl");
  }

  const fetchCatalog = opts.fetchCatalog ?? fetchSkillsCatalog;
  const downloadZip = opts.downloadZip ?? downloadCatalogSkillZip;
  const catalog = await fetchCatalog(opts.catalogUrl);
  const entry = findCatalogSkill(catalog, {
    name: name || undefined,
    downloadUrl: downloadUrl || undefined,
  });
  if (!entry) {
    throw new Error(
      name ? `catalog_skill_not_found: ${name}` : `download_url_not_in_catalog: ${downloadUrl}`,
    );
  }
  if (downloadUrl && downloadUrl !== entry.downloadUrl) {
    throw new Error("download_url_not_in_catalog");
  }

  const installed: string[] = [];
  const skippedDeps: string[] = [];
  const visiting = new Set<string>();
  let primarySha = "";
  let primaryPath = "";
  let primaryVersion = "";

  const ensure = async (skill: CatalogSkill, depth: number, isPrimary: boolean): Promise<void> => {
    if (visiting.has(skill.name)) return;
    visiting.add(skill.name);

    for (const dep of skill.dependencies ?? []) {
      if (loadSkillMetadata(opts.config.skillsRoots, dep)) {
        skippedDeps.push(dep);
        continue;
      }
      if (depth >= MAX_DEP_DEPTH) {
        throw new Error(`catalog_dep_depth_exceeded: ${dep}`);
      }
      const depEntry = findCatalogSkill(catalog, { name: dep });
      if (!depEntry) {
        if (dep.startsWith("platform.")) {
          throw new Error(`missing_platform_skill: ${dep}`);
        }
        throw new Error(`catalog_dependency_not_found: ${dep}`);
      }
      await ensure(depEntry, depth + 1, false);
    }

    const already = loadSkillMetadata(opts.config.skillsRoots, skill.name);
    if (already && !opts.overwrite) {
      if (isPrimary) throw new Error(`skill_exists: ${skill.name}`);
      skippedDeps.push(skill.name);
      return;
    }

    const { bytes, sha256 } = await downloadZip(skill.downloadUrl, skill.sha256);
    const imported = opts.skillPackages.importZip(bytes, { overwrite: Boolean(opts.overwrite) });
    installed.push(imported.skillName);
    if (isPrimary) {
      primarySha = sha256;
      primaryPath = imported.path;
      primaryVersion = imported.version;
    }
  };

  await ensure(entry, 0, true);

  // Primary should be first in installed list for API consumers.
  const ordered = [
    entry.name,
    ...installed.filter((n) => n !== entry.name),
  ];

  return {
    skillName: entry.name,
    path: primaryPath,
    version: primaryVersion,
    catalogUrl: opts.catalogUrl,
    downloadUrl: entry.downloadUrl,
    sha256: primarySha,
    official: entry.official,
    installed: ordered,
    skippedDeps: [...new Set(skippedDeps)],
  };
}

/** Mark which catalog entries are already present in local skill roots. */
export function annotateCatalogInstalled(
  catalog: CatalogSkill[],
  skillsRoots: string[],
): Array<CatalogSkill & { installed: boolean }> {
  const local = new Set(listSkills(skillsRoots).map((s) => s.metadata.name));
  return catalog.map((s) => ({ ...s, installed: local.has(s.name) }));
}
