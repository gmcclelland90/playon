import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { loadImportHintRules } from "./import-hints-data.js";
import type { ServerAdoptionService } from "./server-adoption.js";
import { SkillDraftService } from "./skill-drafts.js";
import { loadSkillMetadata, listSkills } from "./skills.js";
import type { ServerRecord } from "./servers.js";

function sourceHasAnyFile(sourcePath: string, relPaths: string[]): boolean {
  for (const rel of relPaths) {
    const abs = path.join(sourcePath, ...rel.split(/[/\\]/).filter(Boolean));
    if (fs.existsSync(abs)) return true;
  }
  return false;
}

export type ImportLocalArgs = {
  sourcePath: string;
  serverName?: string;
  skillName?: string;
  game?: string;
  nodeId?: string;
};

export type ImportLocalReport = {
  server: ServerRecord;
  skillName: string;
  skillSource: "provided" | "detected" | "draft";
  draftSlug?: string;
  baselineSnapshotId: string;
  copiedBytes: number;
  detectedHints: string[];
  followUp: string[];
};

function assertImportableSource(sourcePath: string, dataRoot: string): string {
  const resolved = path.resolve(sourcePath);
  if (!path.isAbsolute(resolved)) {
    throw new Error("source_path_must_be_absolute");
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`source_not_directory: ${resolved}`);
  }
  const serversRoot = path.resolve(dataRoot, "servers");
  if (resolved === serversRoot || resolved.startsWith(serversRoot + path.sep)) {
    throw new Error("source_inside_servers_root");
  }
  return resolved;
}

/**
 * Lightweight layout sniffers driven by skills/import-hints.yaml.
 * Generic tree markers stay here; game → skill mapping lives in the data file.
 */
export function detectImportHints(
  sourcePath: string,
  skillsRoots: string[] = [],
): {
  hints: string[];
  suggestedGame?: string;
  suggestedSkillName?: string;
} {
  const hints: string[] = [];
  const names = new Set(fs.readdirSync(sourcePath).map((n) => n.toLowerCase()));

  for (const rule of loadImportHintRules(skillsRoots)) {
    if (!sourceHasAnyFile(sourcePath, rule.anyFiles)) continue;
    hints.push(rule.id);
    return {
      hints,
      suggestedGame: rule.suggestedGame,
      suggestedSkillName: rule.suggestedSkillName,
    };
  }

  if (names.has("game") && fs.existsSync(path.join(sourcePath, "skill.json"))) {
    hints.push("playon_server_tree");
  }
  if (names.has("world") || names.has("worlds")) hints.push("has_world_folder");
  if (names.has("mods") || names.has("plugins")) hints.push("has_mods_or_plugins");
  if (names.has("docker-compose.yml") || names.has("compose.yaml")) hints.push("has_compose");

  return { hints };
}

export class ImportLocalService {
  constructor(
    private readonly config: AppConfig,
    private readonly adoption: ServerAdoptionService,
  ) {}

  async importFromPath(args: ImportLocalArgs): Promise<ImportLocalReport> {
    const source = assertImportableSource(args.sourcePath, this.config.dataRoot);
    const detection = detectImportHints(source, this.config.skillsRoots);
    const followUp: string[] = [];

    let skillName = args.skillName?.trim() || detection.suggestedSkillName;
    let skillSource: ImportLocalReport["skillSource"] = args.skillName
      ? "provided"
      : detection.suggestedSkillName
        ? "detected"
        : "draft";
    let draftSlug: string | undefined;

    if (skillName && !loadSkillMetadata(this.config.skillsRoots, skillName)) {
      followUp.push(`skill_not_found:${skillName}`);
      skillName = undefined;
      skillSource = "draft";
    }

    if (!skillName) {
      const drafts = new SkillDraftService(this.config);
      const game = args.game?.trim() || detection.suggestedGame || path.basename(source);
      const saved = drafts.save({
        name: `imported-${game}`,
        game,
        description: `Scaffolded from local import of ${source}`,
        installGuide: [
          `# Imported server: ${game}`,
          "",
          `Source path: \`${source}\``,
          "",
          "Review this draft, then promote it after the host confirms the layout.",
          "",
          detection.hints.length
            ? `Detected hints: ${detection.hints.join(", ")}`
            : "No strong game fingerprint; treat as opaque data tree.",
        ].join("\n"),
        containerSupport: detection.hints.includes("has_compose") ? "partial" : "none",
        warnings: "Imported from existing files — verify ports, EULA, and runtime before starting.",
      });
      draftSlug = saved.slug;
      skillName = saved.skillName;
      skillSource = "draft";
      followUp.push("review_and_promote_draft_skill");
    }

    const target = await this.adoption.resolveTarget(skillName!, args.nodeId);
    const metaName = target.skill.metadata.name;
    const gameLabel =
      args.game?.trim() ||
      target.skill.metadata.game ||
      detection.suggestedGame ||
      path.basename(source);
    const serverName = args.serverName?.trim() || gameLabel;

    const adopted = await this.adoption.adoptLocalTree({
      sourcePath: source,
      skill: target.skill,
      nodeId: target.nodeId,
      runtimeMode: target.runtimeMode,
      serverName,
      gameLabel,
      markerExtras: {
        importedFrom: source,
        importedAt: new Date().toISOString(),
      },
      baselineLabel: "baseline-import",
    });

    followUp.push("verify_start_and_join");
    if (!detection.hints.length) followUp.push("confirm_game_type_with_host");

    const knownSkills = listSkills(this.config.skillsRoots).map((s) => s.metadata.name);
    if (skillSource === "detected" && !knownSkills.includes(metaName)) {
      followUp.push("attach_or_install_matching_skill");
    }

    return {
      server: adopted.server,
      skillName: metaName,
      skillSource,
      draftSlug,
      baselineSnapshotId: adopted.baselineSnapshotId,
      copiedBytes: adopted.copiedBytes,
      detectedHints: detection.hints,
      followUp,
    };
  }
}
