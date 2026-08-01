import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { AppConfig } from "../config.js";
import { listSkills } from "./skills.js";

export interface SkillDraftSaveArgs {
  name: string;
  game: string;
  description: string;
  installGuide: string;
  containerSupport?: "full" | "partial" | "none";
  warnings?: string;
}

export interface SkillDraftRecord {
  slug: string;
  skillName: string;
  path: string;
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "draft";
}

function draftsRoot(config: AppConfig): string {
  return path.join(config.dataRoot, "skills", "_drafts");
}

function promotedRoot(config: AppConfig): string {
  return path.join(config.dataRoot, "skills");
}

export class SkillDraftService {
  constructor(private readonly config: AppConfig) {}

  save(args: SkillDraftSaveArgs): SkillDraftRecord {
    const slug = slugify(args.name);
    const draftDir = path.join(draftsRoot(this.config), slug);
    const guidesDir = path.join(draftDir, "guides");
    fs.mkdirSync(guidesDir, { recursive: true });

    const skillName = `drafts.${slug}`;
    const metadata = {
      name: skillName,
      version: "0.0.1-draft",
      game: args.game,
      description: args.description,
      tags: ["draft"],
      containerSupport: args.containerSupport ?? "none",
    };

    fs.writeFileSync(path.join(draftDir, "metadata.yaml"), yaml.dump(metadata));
    fs.writeFileSync(path.join(guidesDir, "INSTALL.md"), args.installGuide);

    if (args.warnings?.trim()) {
      fs.writeFileSync(path.join(guidesDir, "WARNINGS.md"), args.warnings.trim());
    }

    return { slug, skillName, path: draftDir };
  }

  list(): SkillDraftRecord[] {
    const root = draftsRoot(this.config);
    if (!fs.existsSync(root)) return [];

    return fs
      .readdirSync(root)
      .filter((name) => {
        const dir = path.join(root, name);
        return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, "metadata.yaml"));
      })
      .map((slug) => ({
        slug,
        skillName: `drafts.${slug}`,
        path: path.join(root, slug),
      }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }

  promote(slug: string): { skillName: string; path: string } {
    const draftDir = path.join(draftsRoot(this.config), slug);
    if (!fs.existsSync(draftDir)) {
      throw new Error(`unknown_draft: ${slug}`);
    }

    const metadataPath = path.join(draftDir, "metadata.yaml");
    const raw = yaml.load(fs.readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    const promotedName = String(raw.game ?? slug)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || slug;

    const skillName = promotedName;
    const targetDir = path.join(promotedRoot(this.config), slug);

    if (fs.existsSync(targetDir)) {
      throw new Error(`skill_exists: ${slug}`);
    }

    const tags = Array.isArray(raw.tags)
      ? (raw.tags as string[]).filter((t) => t !== "draft")
      : [];
    const promotedMetadata = {
      ...raw,
      name: skillName,
      version: "0.1.0",
      tags,
    };

    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "metadata.yaml"), yaml.dump(promotedMetadata));

    const draftGuides = path.join(draftDir, "guides");
    if (fs.existsSync(draftGuides)) {
      fs.cpSync(draftGuides, path.join(targetDir, "guides"), { recursive: true });
    }

    fs.rmSync(draftDir, { recursive: true, force: true });

    const entry = listSkills(this.config.skillsRoots).find((s) => s.path === targetDir);
    return {
      skillName: entry?.metadata.name ?? skillName,
      path: targetDir,
    };
  }
}
