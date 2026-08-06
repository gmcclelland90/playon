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

function resolveBesideSkills(skillsRoots: string[], fileName: string): string | null {
  for (const root of skillsRoots) {
    const beside = path.join(path.dirname(root), fileName);
    if (fs.existsSync(beside)) return beside;
    const inside = path.join(root, fileName);
    if (fs.existsSync(inside)) return inside;
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
