import crypto from "node:crypto";
import { z } from "zod";

export const DEFAULT_SKILLS_CATALOG_URL = "https://playon.games/skills/index.json";

export const CatalogSkillSchema = z.object({
  name: z.string(),
  version: z.string(),
  game: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  containerSupport: z.enum(["none", "partial", "full"]).optional(),
  minRamMb: z.number().optional(),
  downloadUrl: z.string().url(),
  sha256: z.string().optional(),
  official: z.boolean().optional(),
});

export const CatalogIndexSchema = z.object({
  updatedAt: z.string().optional(),
  skills: z.array(CatalogSkillSchema),
});

export type CatalogSkill = z.infer<typeof CatalogSkillSchema>;

export type CatalogWarning = {
  name?: string;
  index: number;
  message: string;
};

export type CatalogFetchResult = {
  skills: CatalogSkill[];
  warnings: CatalogWarning[];
  updatedAt?: string;
};

const CatalogIndexLooseSchema = z.object({
  updatedAt: z.string().optional(),
  skills: z.array(z.unknown()),
});

export function resolveSkillsCatalogUrl(
  envUrl?: string | null,
  storedUrl?: string | null,
): string {
  return envUrl?.trim() || storedUrl?.trim() || DEFAULT_SKILLS_CATALOG_URL;
}

/** Parse a catalog index, skipping invalid skill rows instead of failing the whole fetch. */
export function parseCatalogIndex(json: unknown): CatalogFetchResult {
  const loose = CatalogIndexLooseSchema.parse(json);
  const skills: CatalogSkill[] = [];
  const warnings: CatalogWarning[] = [];

  loose.skills.forEach((raw, index) => {
    const parsed = CatalogSkillSchema.safeParse(raw);
    if (parsed.success) {
      skills.push(parsed.data);
      return;
    }
    const name =
      raw && typeof raw === "object" && "name" in raw && typeof (raw as { name: unknown }).name === "string"
        ? (raw as { name: string }).name
        : undefined;
    const issue = parsed.error.issues[0];
    const path = issue?.path?.length ? issue.path.join(".") : "skill";
    const detail = issue?.message ?? "invalid_skill";
    warnings.push({
      name,
      index,
      message: `${path}: ${detail}`,
    });
  });

  return { skills, warnings, updatedAt: loose.updatedAt };
}

export async function fetchSkillsCatalogDetailed(
  catalogUrl: string = DEFAULT_SKILLS_CATALOG_URL,
): Promise<CatalogFetchResult> {
  const res = await fetch(catalogUrl, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`skills_catalog_fetch_failed: ${res.status}`);
  }
  return parseCatalogIndex(await res.json());
}

export async function fetchSkillsCatalog(
  catalogUrl: string = DEFAULT_SKILLS_CATALOG_URL,
): Promise<CatalogSkill[]> {
  return (await fetchSkillsCatalogDetailed(catalogUrl)).skills;
}

export function searchCatalog(skills: CatalogSkill[], query: string): CatalogSkill[] {
  const q = query.trim().toLowerCase();
  if (!q) return skills;
  return skills.filter((s) => {
    const hay = [s.name, s.game ?? "", s.description ?? "", ...s.tags].join(" ").toLowerCase();
    return hay.includes(q);
  });
}

/** Resolve a catalog entry by exact name, then by search, then by downloadUrl. */
export function findCatalogSkill(
  skills: CatalogSkill[],
  opts: { name?: string; downloadUrl?: string },
): CatalogSkill | undefined {
  const name = opts.name?.trim();
  const downloadUrl = opts.downloadUrl?.trim();
  if (name) {
    const exact = skills.find((s) => s.name === name);
    if (exact) return exact;
    const matches = searchCatalog(skills, name);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      const byName = matches.find((s) => s.name.toLowerCase() === name.toLowerCase());
      if (byName) return byName;
    }
  }
  if (downloadUrl) {
    return skills.find((s) => s.downloadUrl === downloadUrl);
  }
  return undefined;
}

export async function downloadCatalogSkillZip(
  downloadUrl: string,
  expectedSha256?: string,
): Promise<{ bytes: Uint8Array; sha256: string }> {
  let parsed: URL;
  try {
    parsed = new URL(downloadUrl);
  } catch {
    throw new Error("catalog_download_invalid_url");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("catalog_download_https_required");
  }

  const res = await fetch(downloadUrl, {
    headers: { accept: "application/zip,*/*" },
  });
  if (!res.ok) {
    throw new Error(`catalog_download_failed: ${res.status}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (expectedSha256 && expectedSha256.toLowerCase() !== sha256.toLowerCase()) {
    throw new Error(`catalog_sha256_mismatch: expected ${expectedSha256} got ${sha256}`);
  }
  return { bytes, sha256 };
}
