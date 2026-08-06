/**
 * Map "Scan for servers" — probe allowlisted roots on a node, then pack + import.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ImportPackResultSchema,
  ImportProbeResultSchema,
  deriveNodePresence,
  isLocalNodeId,
  type ImportProbeCandidate,
} from "@playon/shared";
import { runImportProbe } from "@playon/shared/import-probe-walk";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { nodes } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { loadImportHintRules, loadImportScanRoots } from "./import-hints-data.js";
import type { ImportLocalReport, ImportLocalService } from "./import-local.js";
import { dispatchNodeJob } from "./node-runtime.js";

const SUGGEST_CACHE_TTL_MS = 30_000;
const PACK_MAX_BYTES = 512 * 1024 * 1024;

type CacheEntry = {
  at: number;
  candidates: ImportProbeCandidate[];
  scannedRoots: string[];
};

export class ImportSuggestService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly importLocal: ImportLocalService,
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
      throw new Error("import_scan_roots_missing");
    }

    const probe = await dispatchNodeJob({
      nodeId,
      kind: "import_probe",
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

  async importFromNode(args: {
    nodeId: string;
    sourcePath: string;
    serverName?: string;
    skillName?: string;
  }): Promise<ImportLocalReport> {
    await this.assertNode(args.nodeId);
    const sourcePath = args.sourcePath.trim();
    if (!sourcePath) throw new Error("source_path_required");

    const { roots } = this.rootsAndHints();

    if (isLocalNodeId(args.nodeId)) {
      return this.importLocal.importFromPath({
        sourcePath,
        serverName: args.serverName,
        skillName: args.skillName,
        nodeId: args.nodeId === "local" ? "local" : args.nodeId,
      });
    }

    const pack = await dispatchNodeJob({
      nodeId: args.nodeId,
      kind: "import_pack",
      args: {
        path: sourcePath,
        allowRoots: roots,
        maxBytes: PACK_MAX_BYTES,
      },
      timeoutMs: 300_000,
      localHandler: async () => {
        throw new Error("import_pack_local_unreachable");
      },
    });

    const parsed = ImportPackResultSchema.parse(pack);
    if (!parsed.archiveBase64) {
      throw new Error("import_pack_empty");
    }

    const stagingRoot = path.join(this.config.dataRoot, "imports");
    fs.mkdirSync(stagingRoot, { recursive: true });
    const staging = fs.mkdtempSync(path.join(stagingRoot, "node-"));
    try {
      const archive = path.join(os.tmpdir(), `playon-import-${Date.now()}.tar`);
      fs.writeFileSync(archive, Buffer.from(parsed.archiveBase64, "base64"));
      try {
        execFileSync("tar", ["-xf", archive, "-C", staging], { stdio: "pipe" });
      } finally {
        fs.rmSync(archive, { force: true });
      }

      const report = await this.importLocal.importFromPath({
        sourcePath: staging,
        serverName: args.serverName,
        skillName: args.skillName,
        nodeId: args.nodeId,
      });
      this.cache.delete(args.nodeId);
      return report;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
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
