import {
  CatalogExperienceSchema,
  DEFAULT_EXPERIENCES_CATALOG_URL,
  resolveExperiencesCatalogUrl,
  type CatalogExperience,
} from "@playon/shared";
import { z } from "zod";
import { downloadCatalogSkillZip } from "./skills-catalog.js";

export { DEFAULT_EXPERIENCES_CATALOG_URL, resolveExperiencesCatalogUrl };

export type CatalogExperienceWarning = {
  name?: string;
  index: number;
  message: string;
};

export type ExperiencesCatalogFetchResult = {
  experiences: CatalogExperience[];
  warnings: CatalogExperienceWarning[];
  updatedAt?: string;
  /** Set when the public index is missing (404) — Home treats as empty, not fatal. */
  unavailable?: "not_found" | "fetch_failed";
  catalogUrl: string;
};

const CatalogExperiencesIndexLooseSchema = z.object({
  updatedAt: z.string().optional(),
  experiences: z.array(z.unknown()).default([]),
});

/** Parse experiences catalog index, skipping invalid rows. */
export function parseExperiencesCatalogIndex(json: unknown): Omit<
  ExperiencesCatalogFetchResult,
  "catalogUrl" | "unavailable"
> {
  const loose = CatalogExperiencesIndexLooseSchema.parse(json);
  const experiences: CatalogExperience[] = [];
  const warnings: CatalogExperienceWarning[] = [];

  loose.experiences.forEach((raw, index) => {
    const parsed = CatalogExperienceSchema.safeParse(raw);
    if (parsed.success) {
      experiences.push(parsed.data);
      return;
    }
    const name =
      raw && typeof raw === "object" && "name" in raw && typeof (raw as { name: unknown }).name === "string"
        ? (raw as { name: string }).name
        : undefined;
    const issue = parsed.error.issues[0];
    const path = issue?.path?.length ? issue.path.join(".") : "experience";
    const detail = issue?.message ?? "invalid_experience";
    warnings.push({ name, index, message: `${path}: ${detail}` });
  });

  return { experiences, warnings, updatedAt: loose.updatedAt };
}

export function searchExperiencesCatalog(
  experiences: CatalogExperience[],
  query: string,
): CatalogExperience[] {
  const q = query.trim().toLowerCase();
  if (!q) return experiences;
  return experiences.filter((e) => {
    const hay = [e.name, e.displayName, e.description, e.baseGame, ...e.tags]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

export function findCatalogExperience(
  experiences: CatalogExperience[],
  opts: { name?: string; downloadUrl?: string },
): CatalogExperience | undefined {
  const name = opts.name?.trim();
  const downloadUrl = opts.downloadUrl?.trim();
  if (name) {
    const exact = experiences.find((e) => e.name === name);
    if (exact) return exact;
    const matches = searchExperiencesCatalog(experiences, name);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      const byName = matches.find((e) => e.name.toLowerCase() === name.toLowerCase());
      if (byName) return byName;
    }
  }
  if (downloadUrl) {
    return experiences.find((e) => e.downloadUrl === downloadUrl);
  }
  return undefined;
}

/**
 * Fetch the public experiences catalog.
 * 404 → empty list with unavailable=not_found (playon-games may not have shipped yet).
 */
export async function fetchExperiencesCatalogDetailed(
  catalogUrl: string = DEFAULT_EXPERIENCES_CATALOG_URL,
): Promise<ExperiencesCatalogFetchResult> {
  let res: Response;
  try {
    res = await fetch(catalogUrl, {
      headers: { accept: "application/json" },
    });
  } catch (err) {
    return {
      catalogUrl,
      experiences: [],
      warnings: [],
      unavailable: "fetch_failed",
    };
  }
  if (res.status === 404) {
    return {
      catalogUrl,
      experiences: [],
      warnings: [],
      unavailable: "not_found",
    };
  }
  if (!res.ok) {
    throw new Error(`experiences_catalog_fetch_failed: ${res.status}`);
  }
  const parsed = parseExperiencesCatalogIndex(await res.json());
  return { ...parsed, catalogUrl };
}

export async function downloadCatalogExperienceZip(
  downloadUrl: string,
  expectedSha256?: string,
): Promise<{ bytes: Uint8Array; sha256: string }> {
  return downloadCatalogSkillZip(downloadUrl, expectedSha256);
}
