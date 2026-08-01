import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { servers } from "../db/schema.js";
import { PlacementService } from "./placement.js";
import { SkillDraftService } from "./skill-drafts.js";
import { loadSkillMetadata, listSkills } from "./skills.js";
import type { ServerRecord, ServerService } from "./servers.js";
import type { SnapshotService } from "./snapshots.js";

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

function dirSizeBytes(root: string): number {
  let total = 0;
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const st = fs.statSync(abs);
      if (st.isDirectory()) walk(abs);
      else total += st.size;
    }
  };
  walk(root);
  return total;
}

/** Lightweight layout sniffers — not a full game detector. */
export function detectImportHints(sourcePath: string): {
  hints: string[];
  suggestedGame?: string;
  suggestedSkillName?: string;
} {
  const hints: string[] = [];
  const names = new Set(fs.readdirSync(sourcePath).map((n) => n.toLowerCase()));

  if (names.has("server.properties") || names.has("paper.yml") || names.has("spigot.yml")) {
    hints.push("minecraft_java_layout");
    return {
      hints,
      suggestedGame: "Minecraft",
      suggestedSkillName: "games.minecraft-paper",
    };
  }
  if (names.has("valheim_server") || (names.has("start_server.sh") && names.has("steamapps"))) {
    hints.push("valheimish_layout");
    return { hints, suggestedGame: "Valheim" };
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
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly servers: ServerService,
    private readonly snapshots: SnapshotService,
  ) {}

  async importFromPath(args: ImportLocalArgs): Promise<ImportLocalReport> {
    const source = assertImportableSource(args.sourcePath, this.config.dataRoot);
    const detection = detectImportHints(source);
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

    const skill = loadSkillMetadata(this.config.skillsRoots, skillName!);
    if (!skill) throw new Error(`unknown_skill: ${skillName}`);

    const placement = new PlacementService(this.db, this.config);
    const resolvedNodeId = await placement.resolveNodeId(skill.metadata.name, args.nodeId);

    const id = nanoid();
    const dataPath = path.join(this.config.dataRoot, "servers", id);
    const gamePath = path.join(dataPath, "game");
    fs.mkdirSync(gamePath, { recursive: true });

    // If source already looks like a PlayOn jail (has game/), copy that subtree; else copy whole tree into game/
    const nestedGame = path.join(source, "game");
    const copyFrom =
      fs.existsSync(nestedGame) && fs.statSync(nestedGame).isDirectory() ? nestedGame : source;
    fs.cpSync(copyFrom, gamePath, { recursive: true });
    const copiedBytes = dirSizeBytes(gamePath);

    const metaName = skill.metadata.name;
    const metaVersion = skill.metadata.version;
    const containerSupport = skill.metadata.containerSupport;
    const gameLabel =
      args.game?.trim() || skill.metadata.game || detection.suggestedGame || path.basename(source);
    const serverName = args.serverName?.trim() || gameLabel;

    fs.writeFileSync(
      path.join(dataPath, "skill.json"),
      JSON.stringify(
        {
          skillName: metaName,
          version: metaVersion,
          runtimeMode: this.config.runtimeMode,
          containerSupport,
          nodeId: resolvedNodeId,
          importedFrom: source,
          importedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    const now = new Date();
    await this.db.insert(servers).values({
      id,
      name: serverName,
      game: gameLabel,
      nodeId: resolvedNodeId,
      runtimeMode:
        metaName === "games.windows-native-stub" ? "native" : this.config.runtimeMode,
      status: "stopped",
      dataPath,
      createdAt: now,
    });

    const baseline = await this.snapshots.create(id, "baseline-import");
    followUp.push("verify_start_and_join");
    if (!detection.hints.length) followUp.push("confirm_game_type_with_host");

    const knownSkills = listSkills(this.config.skillsRoots).map((s) => s.metadata.name);
    if (skillSource === "detected" && !knownSkills.includes(metaName)) {
      followUp.push("attach_or_install_matching_skill");
    }

    const server = (await this.servers.get(id))!;
    return {
      server,
      skillName: metaName,
      skillSource,
      draftSlug,
      baselineSnapshotId: baseline.id,
      copiedBytes,
      detectedHints: detection.hints,
      followUp,
    };
  }
}
