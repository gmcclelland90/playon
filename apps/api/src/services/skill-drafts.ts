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
  /** When set, writes query/connector.mjs and sets queryDialect: skill_module. */
  queryConnectorSource?: string;
  /** Optional guides/QUERY.md content. */
  queryGuide?: string;
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
    const hasConnector = Boolean(args.queryConnectorSource?.trim());
    const metadata: Record<string, unknown> = {
      name: skillName,
      version: "0.0.1-draft",
      game: args.game,
      description: args.description,
      tags: ["draft"],
      containerSupport: args.containerSupport ?? "none",
    };
    if (hasConnector) {
      metadata.queryDialect = "skill_module";
      metadata.queryConnector = "query/connector.mjs";
    }

    fs.writeFileSync(path.join(draftDir, "metadata.yaml"), yaml.dump(metadata));
    fs.writeFileSync(path.join(guidesDir, "INSTALL.md"), args.installGuide);

    if (args.warnings?.trim()) {
      fs.writeFileSync(path.join(guidesDir, "WARNINGS.md"), args.warnings.trim());
    }

    if (hasConnector) {
      this.writeQueryConnector(draftDir, args.queryConnectorSource!.trim(), args.queryGuide);
    } else if (args.queryGuide?.trim()) {
      fs.writeFileSync(path.join(guidesDir, "QUERY.md"), args.queryGuide.trim());
    }

    return { slug, skillName, path: draftDir };
  }

  /** Update or create query/connector.mjs on an existing draft and set skill_module. */
  setQueryConnector(
    slug: string,
    connectorSource: string,
    queryGuide?: string,
  ): SkillDraftRecord {
    const draftDir = path.join(draftsRoot(this.config), slug);
    if (!fs.existsSync(draftDir)) {
      throw new Error(`unknown_draft: ${slug}`);
    }
    this.writeQueryConnector(draftDir, connectorSource, queryGuide);

    const metadataPath = path.join(draftDir, "metadata.yaml");
    const raw = (yaml.load(fs.readFileSync(metadataPath, "utf8")) ?? {}) as Record<string, unknown>;
    raw.queryDialect = "skill_module";
    raw.queryConnector = "query/connector.mjs";
    fs.writeFileSync(metadataPath, yaml.dump(raw));

    return { slug, skillName: `drafts.${slug}`, path: draftDir };
  }

  private writeQueryConnector(draftDir: string, source: string, queryGuide?: string): void {
    const queryDir = path.join(draftDir, "query");
    fs.mkdirSync(queryDir, { recursive: true });
    fs.writeFileSync(path.join(queryDir, "connector.mjs"), source, "utf8");
    if (queryGuide?.trim()) {
      fs.mkdirSync(path.join(draftDir, "guides"), { recursive: true });
      fs.writeFileSync(path.join(draftDir, "guides", "QUERY.md"), queryGuide.trim());
    }
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

    const draftQuery = path.join(draftDir, "query");
    if (fs.existsSync(draftQuery)) {
      fs.cpSync(draftQuery, path.join(targetDir, "query"), { recursive: true });
    }

    fs.rmSync(draftDir, { recursive: true, force: true });

    const entry = listSkills(this.config.skillsRoots).find((s) => s.path === targetDir);
    return {
      skillName: entry?.metadata.name ?? skillName,
      path: targetDir,
    };
  }
}
