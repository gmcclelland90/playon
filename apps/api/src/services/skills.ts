import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { SkillMetadataSchema, type SkillMetadata } from "@playon/shared";

export interface SkillEntry {
  id: string;
  path: string;
  metadata: SkillMetadata;
}

function skillIdFromPath(skillDir: string, root: string): string {
  const rel = path.relative(root, skillDir).replace(/\\/g, "/");
  return rel || path.basename(skillDir);
}

function loadMetadataFile(metadataPath: string): SkillMetadata {
  const raw = yaml.load(fs.readFileSync(metadataPath, "utf8"));
  return SkillMetadataSchema.parse(raw);
}

function scanSkillsRoot(root: string): SkillEntry[] {
  if (!fs.existsSync(root)) return [];

  const entries: SkillEntry[] = [];
  const walk = (dir: string) => {
    const metadataPath = path.join(dir, "metadata.yaml");
    if (fs.existsSync(metadataPath)) {
      entries.push({
        id: skillIdFromPath(dir, root),
        path: dir,
        metadata: loadMetadataFile(metadataPath),
      });
      return;
    }
    for (const name of fs.readdirSync(dir)) {
      const child = path.join(dir, name);
      if (fs.statSync(child).isDirectory()) walk(child);
    }
  };

  walk(root);
  return entries;
}

export function listSkills(skillsRoots: string[]): SkillEntry[] {
  const byName = new Map<string, SkillEntry>();
  for (const root of skillsRoots) {
    for (const entry of scanSkillsRoot(root)) {
      byName.set(entry.metadata.name, entry);
    }
  }
  return [...byName.values()].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
}

export function loadSkillMetadata(skillsRoots: string[], skillName: string): SkillEntry | null {
  return listSkills(skillsRoots).find((s) => s.metadata.name === skillName) ?? null;
}
