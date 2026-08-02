import fs from "node:fs";
import path from "node:path";
import { strFromU8, unzipSync, zipSync } from "fflate";
import yaml from "js-yaml";
import { SkillMetadataSchema } from "@playon/shared";
import type { AppConfig } from "../config.js";
import { loadSkillMetadata } from "./skills.js";

function globalSkillsRoot(config: AppConfig): string {
  return path.join(config.dataRoot, "skills");
}

export function serverSkillsRoot(config: AppConfig, serverId: string): string {
  return path.join(config.dataRoot, "servers", serverId, "skills");
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "skill"
  );
}

function walkFiles(dir: string, prefix = ""): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      Object.assign(out, walkFiles(abs, rel));
    } else if (st.isFile()) {
      out[rel.replace(/\\/g, "/")] = new Uint8Array(fs.readFileSync(abs));
    }
  }
  return out;
}

function assertSafeZipPath(entry: string): string {
  const normalized = entry.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..") || path.isAbsolute(normalized)) {
    throw new Error(`unsafe_zip_path: ${entry}`);
  }
  return normalized;
}

function resolveZipRoot(files: Record<string, Uint8Array>): {
  rootPrefix: string;
  metadataRaw: string;
} {
  if (files["metadata.yaml"]) {
    return { rootPrefix: "", metadataRaw: strFromU8(files["metadata.yaml"]) };
  }
  const metaEntry = Object.keys(files).find((k) => /^[^/]+\/metadata\.yaml$/.test(k));
  if (!metaEntry) throw new Error("missing_metadata_yaml");
  const rootPrefix = metaEntry.slice(0, metaEntry.indexOf("/"));
  return { rootPrefix, metadataRaw: strFromU8(files[metaEntry]!) };
}

function writeSkillTree(
  targetDir: string,
  files: Record<string, Uint8Array>,
  rootPrefix: string,
): void {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const [entry, data] of Object.entries(files)) {
    const safe = assertSafeZipPath(entry);
    const rel =
      rootPrefix && (safe === rootPrefix || safe.startsWith(`${rootPrefix}/`))
        ? safe.slice(rootPrefix.length).replace(/^\//, "")
        : safe;
    if (!rel) continue;
    const dest = path.join(targetDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
}

export class SkillPackageService {
  constructor(private readonly config: AppConfig) {}

  exportZip(skillName: string): { filename: string; bytes: Uint8Array; metadataName: string } {
    const entry = loadSkillMetadata(this.config.skillsRoots, skillName);
    if (!entry) throw new Error(`unknown_skill: ${skillName}`);
    const files = walkFiles(entry.path);
    if (!files["metadata.yaml"]) throw new Error("missing_metadata_yaml");
    const bytes = zipSync(files, { level: 6 });
    const slug = slugify(entry.metadata.name);
    return {
      filename: `${slug}-${entry.metadata.version}.skill.zip`,
      bytes,
      metadataName: entry.metadata.name,
    };
  }

  importZip(
    zipBytes: Uint8Array,
    opts?: { overwrite?: boolean },
  ): { skillName: string; path: string; version: string } {
    const files = unzipSync(zipBytes);
    const safeFiles: Record<string, Uint8Array> = {};
    for (const [key, value] of Object.entries(files)) {
      safeFiles[assertSafeZipPath(key)] = value;
    }
    const { rootPrefix, metadataRaw } = resolveZipRoot(safeFiles);
    const metadata = SkillMetadataSchema.parse(yaml.load(metadataRaw));
    const slug = slugify(metadata.name);
    const targetDir = path.join(globalSkillsRoot(this.config), slug);

    if (fs.existsSync(targetDir) && !opts?.overwrite) {
      throw new Error(`skill_exists: ${slug}`);
    }
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }

    writeSkillTree(targetDir, safeFiles, rootPrefix);
    // Ensure metadata matches validated parse (normalise on disk)
    fs.writeFileSync(path.join(targetDir, "metadata.yaml"), yaml.dump(metadata));

    return { skillName: metadata.name, path: targetDir, version: metadata.version };
  }

  /** Copy a per-server skill tree into the host global skills root. */
  promoteServerSkill(
    serverId: string,
    skillSlug: string,
    opts?: { overwrite?: boolean },
  ): { skillName: string; path: string } {
    const sourceDir = path.join(serverSkillsRoot(this.config, serverId), skillSlug);
    if (!fs.existsSync(path.join(sourceDir, "metadata.yaml"))) {
      throw new Error(`unknown_server_skill: ${serverId}/${skillSlug}`);
    }
    const raw = yaml.load(fs.readFileSync(path.join(sourceDir, "metadata.yaml"), "utf8"));
    const metadata = SkillMetadataSchema.parse(raw);
    const slug = slugify(metadata.name);
    const targetDir = path.join(globalSkillsRoot(this.config), slug);

    if (fs.existsSync(targetDir) && !opts?.overwrite) {
      throw new Error(`skill_exists: ${slug}`);
    }
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    fs.cpSync(sourceDir, targetDir, { recursive: true });
    return { skillName: metadata.name, path: targetDir };
  }

  /** Convenience for tests / agent tools: pack a directory that already has metadata.yaml. */
  packDirectory(skillDir: string): Uint8Array {
    const files = walkFiles(skillDir);
    if (!files["metadata.yaml"]) throw new Error("missing_metadata_yaml");
    return zipSync(files, { level: 6 });
  }
}
