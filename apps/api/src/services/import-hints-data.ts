/**
 * Load import fingerprint rules + OS scan roots from skills YAML (beside skills roots).
 */
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import {
  ImportHintRuleSchema,
  type ImportHintRule,
} from "@playon/shared";

const ImportHintsFileSchema = z.object({
  version: z.number().int().positive().default(1),
  hints: z.array(ImportHintRuleSchema).default([]),
});

const ImportScanRootsFileSchema = z.object({
  version: z.number().int().positive().default(1),
  linux: z.array(z.string().min(1)).default([]),
  windows: z.array(z.string().min(1)).default([]),
});

/**
 * Locate import-hints / import-scan-roots YAML for a skills root.
 *
 * Search order (first hit wins):
 * 1. Inside the root — isolated test fixtures and dataRoot/skills copies.
 *    Must beat "beside", otherwise a leftover file in os.tmpdir() (the parent of
 *    mkdtemp dirs) shadows the fixture and Scan returns no candidates.
 * 2. Beside the root — `skills/platform` → `skills/import-*.yaml`.
 * 3. Repo `skills/` next to `catalog/platform|fixtures` (Phase 4 layout).
 */
function resolveBesideSkills(skillsRoots: string[], fileName: string): string | null {
  for (const root of skillsRoots) {
    const abs = path.resolve(root);
    const candidates = [path.join(abs, fileName), path.join(path.dirname(abs), fileName)];
    const base = path.basename(abs);
    if (base === "platform" || base === "fixtures") {
      candidates.push(path.resolve(abs, "..", "..", "skills", fileName));
    }
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function loadImportHintRules(skillsRoots: string[]): ImportHintRule[] {
  const file = resolveBesideSkills(skillsRoots, "import-hints.yaml");
  if (!file) return [];
  try {
    const raw = yaml.load(fs.readFileSync(file, "utf8"));
    return ImportHintsFileSchema.parse(raw).hints;
  } catch {
    return [];
  }
}

/** Candidate root patterns for the current (or given) platform. */
export function loadImportScanRoots(
  skillsRoots: string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  const file = resolveBesideSkills(skillsRoots, "import-scan-roots.yaml");
  if (!file) return [];
  try {
    const raw = yaml.load(fs.readFileSync(file, "utf8"));
    const parsed = ImportScanRootsFileSchema.parse(raw);
    return platform === "win32" ? parsed.windows : parsed.linux;
  } catch {
    return [];
  }
}
