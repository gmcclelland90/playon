/**
 * Map "Scan for servers" — probe allowlisted roots on a node, then pack + manage.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  ImportPackResultSchema,
  ImportProbeResultSchema,
  ManagePackReadResultSchema,
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
/** Large Steam installs (e.g. Zomboid ~7GiB) stage on the node data disk. */
const PACK_MAX_BYTES = 32 * 1024 * 1024 * 1024;
const PACK_CHUNK_BYTES = 8 * 1024 * 1024;

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

    const pack = ImportPackResultSchema.parse(
      await dispatchNodeJob({
        nodeId: args.nodeId,
        kind: "manage_pack",
        args: {
          path: sourcePath,
          allowRoots: roots,
          maxBytes: PACK_MAX_BYTES,
        },
        timeoutMs: 1_800_000,
        localHandler: async () => {
          throw new Error("manage_pack_local_unreachable");
        },
      }),
    );

    if (!pack.packRel || pack.bytes <= 0) {
      throw new Error("manage_pack_empty");
    }

    const stagingRoot = path.join(this.config.dataRoot, "imports");
    fs.mkdirSync(stagingRoot, { recursive: true });
    const staging = fs.mkdtempSync(path.join(stagingRoot, "node-"));
    const archive = path.join(staging, "tree.tar");
    try {
      await this.pullPackChunks(args.nodeId, pack.packRel, pack.bytes, archive);
      execFileSync("tar", ["-xf", archive, "-C", staging], { stdio: "pipe" });
      fs.rmSync(archive, { force: true });

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
      await dispatchNodeJob({
        nodeId: args.nodeId,
        kind: "fs_remove",
        args: { path: pack.packRel },
        timeoutMs: 60_000,
        localHandler: async () => ({ ok: true }),
      }).catch(() => undefined);
    }
  }

  private async pullPackChunks(
    nodeId: string,
    packRel: string,
    totalBytes: number,
    destFile: string,
  ): Promise<void> {
    const fd = fs.openSync(destFile, "w");
    try {
      let offset = 0;
      while (offset < totalBytes) {
        const chunk = ManagePackReadResultSchema.parse(
          await dispatchNodeJob({
            nodeId,
            kind: "manage_pack_read",
            args: {
              packRel,
              offset,
              length: PACK_CHUNK_BYTES,
            },
            timeoutMs: 120_000,
            localHandler: async () => {
              throw new Error("manage_pack_read_local_unreachable");
            },
          }),
        );
        if (chunk.bytes <= 0) break;
        const buf = Buffer.from(chunk.dataBase64, "base64");
        fs.writeSync(fd, buf);
        offset += chunk.bytes;
        if (chunk.done) break;
      }
      if (offset !== totalBytes) {
        throw new Error(`manage_pack_incomplete: got ${offset} of ${totalBytes} bytes`);
      }
    } finally {
      fs.closeSync(fd);
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
