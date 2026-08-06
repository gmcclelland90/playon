/**
 * Map Scan → Manage: probe allowlisted roots, then seed on the node (no LAN haul).
 */
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import {
  ImportProbeResultSchema,
  ManageSeedResultSchema,
  NODE_AUTHORITATIVE_MARKER,
  deriveNodePresence,
  isLocalNodeId,
  type ImportProbeCandidate,
} from "@playon/shared";
import { runImportProbe } from "@playon/shared/import-probe-walk";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { eq } from "drizzle-orm";
import { nodes, servers } from "../db/schema.js";
import { loadImportHintRules, loadImportScanRoots } from "./import-hints-data.js";
import type { ImportLocalReport, ImportLocalService } from "./import-local.js";
import { PlacementService } from "./placement.js";
import { SkillDraftService } from "./skill-drafts.js";
import { writeSkillMarkerFromSkill } from "./skill-marker.js";
import { listSkills, loadSkillMetadata } from "./skills.js";
import type { ServerService } from "./servers.js";
import type { SnapshotService } from "./snapshots.js";
import { dispatchNodeJob, nodeServerRelPath } from "./node-runtime.js";

const SUGGEST_CACHE_TTL_MS = 30_000;

type CacheEntry = {
  at: number;
  candidates: ImportProbeCandidate[];
  scannedRoots: string[];
};

export class ManageSuggestService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly importLocal: ImportLocalService,
    private readonly serversSvc: ServerService,
    private readonly snapshots: SnapshotService,
  ) {}

  private rootsAndHints() {
    const roots = loadImportScanRoots(this.config.skillsRoots);
    const hints = loadImportHintRules(this.config.skillsRoots);
    return { roots, hints };
  }

  async suggest(nodeId: string): Promise<{
    candidates: ImportProbeCandidate[];
    scannedRoots: string[];
    cached: boolean;
  }> {
    await this.assertNode(nodeId);
    const hit = this.cache.get(nodeId);
    if (hit && Date.now() - hit.at < SUGGEST_CACHE_TTL_MS) {
      return {
        candidates: hit.candidates,
        scannedRoots: hit.scannedRoots,
        cached: true,
      };
    }

    const { roots, hints } = this.rootsAndHints();
    if (!roots.length) {
      throw new Error("manage_scan_roots_missing");
    }

    const probe = await dispatchNodeJob({
      nodeId,
      kind: "manage_probe",
      args: {
        roots,
        hints,
        maxDepth: 2,
        maxCandidates: 40,
      },
      timeoutMs: 60_000,
      localHandler: () =>
        runImportProbe({
          roots,
          hints,
          maxDepth: 2,
          maxCandidates: 40,
        }),
    });

    const parsed = ImportProbeResultSchema.parse(probe);
    this.cache.set(nodeId, {
      at: Date.now(),
      candidates: parsed.candidates,
      scannedRoots: parsed.scannedRoots,
    });
    return {
      candidates: parsed.candidates,
      scannedRoots: parsed.scannedRoots,
      cached: false,
    };
  }

  async manageFromNode(args: {
    nodeId: string;
    sourcePath: string;
    serverName?: string;
    skillName?: string;
    game?: string;
  }): Promise<ImportLocalReport> {
    await this.assertNode(args.nodeId);
    const sourcePath = args.sourcePath.trim();
    if (!sourcePath) throw new Error("source_path_required");

    if (isLocalNodeId(args.nodeId)) {
      return this.importLocal.importFromPath({
        sourcePath,
        serverName: args.serverName,
        skillName: args.skillName,
        game: args.game,
        nodeId: args.nodeId === "local" ? "local" : args.nodeId,
      });
    }

    const { roots } = this.rootsAndHints();
    const followUp: string[] = [];
    let skillName = args.skillName?.trim();
    let skillSource: ImportLocalReport["skillSource"] = skillName ? "provided" : "detected";
    let draftSlug: string | undefined;

    if (skillName && !loadSkillMetadata(this.config.skillsRoots, skillName)) {
      followUp.push(`skill_not_found:${skillName}`);
      skillName = undefined;
      skillSource = "draft";
    }

    if (!skillName) {
      const drafts = new SkillDraftService(this.config);
      const game = args.game?.trim() || path.basename(sourcePath);
      const saved = drafts.save({
        name: `managed-${game}`,
        game,
        description: `Scaffolded from manage of ${sourcePath} on node ${args.nodeId}`,
        installGuide: [
          `# Managed server: ${game}`,
          "",
          `Source path on node: \`${sourcePath}\``,
          "",
          "Files were copied on the node into PlayOn’s server jail. Review/promote this draft if needed.",
        ].join("\n"),
        containerSupport: "none",
        warnings: "Managed from an existing install — stop the old host service before Start in PlayOn.",
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
    fs.mkdirSync(path.join(dataPath, "game"), { recursive: true });

    const metaName = skill.metadata.name;
    const gameLabel = args.game?.trim() || skill.metadata.game || path.basename(sourcePath);
    const serverName = args.serverName?.trim() || gameLabel;

    writeSkillMarkerFromSkill(dataPath, skill, this.config.runtimeMode, resolvedNodeId, {
      managedFrom: sourcePath,
      managedAt: new Date().toISOString(),
      nodeAuthoritative: true,
    });
    fs.writeFileSync(path.join(dataPath, NODE_AUTHORITATIVE_MARKER), `${args.nodeId}\n`);

    const now = new Date();
    await this.db.insert(servers).values({
      id,
      name: serverName,
      game: gameLabel,
      nodeId: resolvedNodeId,
      runtimeMode: this.config.runtimeMode,
      status: "stopped",
      dataPath,
      createdAt: now,
    });

    const destRel = nodeServerRelPath(id, "game");
    const seed = ManageSeedResultSchema.parse(
      await dispatchNodeJob({
        nodeId: args.nodeId,
        kind: "manage_seed",
        args: {
          sourcePath,
          allowRoots: roots,
          destRel,
        },
        timeoutMs: 1_800_000,
        localHandler: async () => {
          throw new Error("manage_seed_local_unreachable");
        },
      }),
    );

    const skillJson = fs.readFileSync(path.join(dataPath, "skill.json"), "utf8");
    await dispatchNodeJob({
      nodeId: args.nodeId,
      kind: "fs_write_text",
      args: {
        path: nodeServerRelPath(id, "skill.json"),
        content: skillJson,
      },
      timeoutMs: 60_000,
      localHandler: async () => ({ ok: true }),
    });

    // Remote Start looks for start.sh; many installs use start-server.sh / game binaries instead.
    const startWrapper = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'cd "$(dirname "$0")"',
      'if [[ -x ./start-server.sh ]]; then exec ./start-server.sh "$@"; fi',
      'if [[ -f ./start-server.sh ]]; then exec /bin/bash ./start-server.sh "$@"; fi',
      'if [[ -x ./StartServer64.sh ]]; then exec ./StartServer64.sh "$@"; fi',
      'if [[ -f ./StartServer64.sh ]]; then exec /bin/bash ./StartServer64.sh "$@"; fi',
      'if [[ -x ./ProjectZomboid64 ]]; then exec ./ProjectZomboid64 "$@"; fi',
      'if [[ -x ./start.sh && "$0" != ./start.sh ]]; then exec ./start.sh "$@"; fi',
      'echo "playon: no launch script/binary found in $(pwd)" >&2',
      "exit 1",
      "",
    ].join("\n");
    await dispatchNodeJob({
      nodeId: args.nodeId,
      kind: "fs_write_text",
      args: {
        path: nodeServerRelPath(id, "game", "start.sh"),
        content: startWrapper,
      },
      timeoutMs: 60_000,
      localHandler: async () => ({ ok: true }),
    });

    const baseline = await this.snapshots.create(id, "baseline-manage");
    followUp.push("stop_old_host_service_before_start");
    followUp.push("verify_start_and_join");

    const knownSkills = listSkills(this.config.skillsRoots).map((s) => s.metadata.name);
    if (skillSource === "detected" && !knownSkills.includes(metaName)) {
      followUp.push("attach_or_install_matching_skill");
    }

    this.cache.delete(args.nodeId);
    const record = await this.serversSvc.get(id);
    if (!record) throw new Error(`server_missing_after_manage: ${id}`);

    return {
      server: record,
      skillName: metaName,
      skillSource,
      draftSlug,
      baselineSnapshotId: baseline.id,
      copiedBytes: seed.bytesCopied,
      detectedHints: [],
      followUp,
    };
  }

  private async assertNode(nodeId: string): Promise<void> {
    if (isLocalNodeId(nodeId)) return;
    const rows = await this.db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!rows[0]) throw new Error(`unknown_node: ${nodeId}`);
    if (deriveNodePresence(rows[0].lastSeenAt) !== "online") {
      throw new Error(`node_not_online: ${nodeId}`);
    }
  }
}
