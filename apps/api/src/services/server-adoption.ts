/**
 * Shared Home pipeline for adopting a server onto PlayOn
 * (create-from-skill, import-local, import-sftp, manage cutover).
 *
 * Owns tree materialization + skill marker + baseline snapshot orchestration.
 * Does not own lifecycle (Handle) or raw path jail (File Store).
 */
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { NODE_AUTHORITATIVE_MARKER } from "@playon/shared";
import type { AppConfig } from "../config.js";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { servers } from "../db/schema.js";
import { PlacementService } from "./placement.js";
import {
  openServerFileStore,
  type ServerFileStoreServer,
} from "./server-file-store.js";
import { writeSkillMarkerFromSkill } from "./skill-marker.js";
import { loadSkillMetadata, type SkillEntry } from "./skills.js";
import type { ServerRecord, ServerService } from "./servers.js";
import type { SnapshotService } from "./snapshots.js";

function toServerRecord(row: typeof servers.$inferSelect): ServerRecord {
  return {
    id: row.id,
    name: row.name,
    game: row.game,
    nodeId: row.nodeId,
    runtimeMode: row.runtimeMode,
    status: row.status,
    dataPath: row.dataPath,
    createdAt: row.createdAt,
  };
}

export type AdoptionRuntimeMode = "native" | "docker";

export type ResolvedAdoptionTarget = {
  skill: SkillEntry;
  nodeId: string;
  runtimeMode: AdoptionRuntimeMode;
};

export type AllocatedServerHome = {
  id: string;
  dataPath: string;
};

export type InsertServerRowArgs = {
  id: string;
  name: string;
  game: string;
  nodeId: string | null;
  runtimeMode: AdoptionRuntimeMode;
  dataPath: string;
};

export type AdoptLocalTreeArgs = {
  sourcePath: string;
  skill: SkillEntry;
  nodeId: string | null;
  runtimeMode: AdoptionRuntimeMode;
  serverName: string;
  gameLabel: string;
  markerExtras?: Record<string, unknown>;
  baselineLabel?: string;
};

export type AdoptLocalTreeResult = {
  server: ServerRecord;
  baselineSnapshotId: string;
  copiedBytes: number;
  id: string;
  dataPath: string;
};

export type BeginManagedAdoptArgs = {
  skill: SkillEntry;
  nodeId: string;
  runtimeMode: AdoptionRuntimeMode;
  serverName: string;
  gameLabel: string;
  managedFrom: string;
};

function requireNodeId(nodeId: string | null, context: string): string {
  if (!nodeId) throw new Error(`node_required: ${context}`);
  return nodeId;
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

export class ServerAdoptionService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly serversSvc: ServerService,
    private readonly snapshots: SnapshotService | null = null,
  ) {}

  resolveRuntimeMode(containerSupport: string): AdoptionRuntimeMode {
    if (this.config.runtimeMode === "native") return "native";
    if (containerSupport === "none") return "native";
    return "docker";
  }

  async resolveTarget(skillName: string, nodeId?: string): Promise<ResolvedAdoptionTarget> {
    const skill = loadSkillMetadata(this.config.skillsRoots, skillName);
    if (!skill) throw new Error(`unknown_skill: ${skillName}`);

    const placement = new PlacementService(this.db, this.config);
    const resolvedNodeId = await placement.resolveNodeId(skill.metadata.name, nodeId);
    const runtimeMode = this.resolveRuntimeMode(skill.metadata.containerSupport);
    return { skill, nodeId: resolvedNodeId, runtimeMode };
  }

  allocateHome(existing?: { id: string; dataPath: string }): AllocatedServerHome {
    if (existing) return { id: existing.id, dataPath: existing.dataPath };
    const id = nanoid();
    return { id, dataPath: path.join(this.config.dataRoot, "servers", id) };
  }

  /** Raw row read — no status reconciliation (adoption must not poke Home docker/native). */
  private async peekServer(id: string): Promise<ServerRecord | null> {
    const rows = await this.db.select().from(servers).where(eq(servers.id, id)).limit(1);
    return rows[0] ? toServerRecord(rows[0]) : null;
  }

  /**
   * Ensure dirs inside the Home jail via File Store.
   * Always locality "local" — adoption materializes on Home; remote provision stays at start/manage seed.
   * Uses `servers.files` when the row exists; otherwise a provisional File Store identity.
   */
  async ensureJailDirs(
    identity: ServerFileStoreServer,
    dirs: string[] = ["game"],
  ): Promise<void> {
    let store;
    try {
      store = await this.serversSvc.files(identity.id, { locality: "local" });
    } catch {
      store = openServerFileStore(identity, {}, { locality: "local" });
    }
    for (const rel of dirs) {
      await store.ensureDir(rel);
    }
  }

  writeMarker(
    dataPath: string,
    skill: SkillEntry,
    runtimeMode: string,
    nodeId: string | null,
    extras?: Record<string, unknown>,
  ): void {
    writeSkillMarkerFromSkill(dataPath, skill, runtimeMode, nodeId, extras);
  }

  writeNodeAuthoritativeMarker(dataPath: string, nodeId: string): void {
    fs.writeFileSync(path.join(dataPath, NODE_AUTHORITATIVE_MARKER), `${nodeId}\n`);
  }

  async insertServerRow(args: InsertServerRowArgs): Promise<void> {
    await this.db.insert(servers).values({
      id: args.id,
      name: args.name,
      game: args.game,
      nodeId: args.nodeId,
      runtimeMode: args.runtimeMode,
      status: "stopped",
      dataPath: args.dataPath,
      createdAt: new Date(),
    });
  }

  async createBaseline(serverId: string, label: string): Promise<{ id: string }> {
    if (!this.snapshots) throw new Error("snapshots_required");
    return this.snapshots.create(serverId, label);
  }

  /**
   * Materialize Home dirs + skill marker (create and reinstall share this).
   */
  async materializeSkillHome(
    identity: AllocatedServerHome & { nodeId: string | null },
    skill: SkillEntry,
    runtimeMode: string,
    extras?: Record<string, unknown>,
  ): Promise<void> {
    await this.ensureJailDirs(identity);
    this.writeMarker(identity.dataPath, skill, runtimeMode, identity.nodeId, extras);
  }

  /**
   * Bulk-import an external tree into the Home jail's game/ (source is outside the server dir).
   */
  stageExternalTreeIntoGame(sourcePath: string, dataPath: string): number {
    const gamePath = path.join(dataPath, "game");
    const nestedGame = path.join(sourcePath, "game");
    const copyFrom =
      fs.existsSync(nestedGame) && fs.statSync(nestedGame).isDirectory() ? nestedGame : sourcePath;
    fs.cpSync(copyFrom, gamePath, { recursive: true });
    return dirSizeBytes(gamePath);
  }

  async createFromSkill(args: {
    skillName: string;
    serverName?: string;
    nodeId?: string;
  }): Promise<ServerRecord> {
    const target = await this.resolveTarget(args.skillName, args.nodeId);
    const home = this.allocateHome();
    await this.materializeSkillHome(
      { ...home, nodeId: target.nodeId },
      target.skill,
      target.runtimeMode,
    );

    const name = args.serverName ?? target.skill.metadata.game ?? target.skill.metadata.name;
    await this.insertServerRow({
      id: home.id,
      name,
      game: target.skill.metadata.game ?? target.skill.metadata.name,
      nodeId: target.nodeId,
      runtimeMode: target.runtimeMode,
      dataPath: home.dataPath,
    });

    const record = await this.peekServer(home.id);
    if (!record) throw new Error(`server_missing_after_create: ${home.id}`);
    return record;
  }

  /**
   * After reinstall wipe: re-bind skill marker + dirs on the existing Home path.
   * Caller owns stop/wipe/DB row update.
   */
  async rematerializeForReinstall(
    existing: ServerRecord,
    args: { skillName: string; nodeId?: string },
  ): Promise<ResolvedAdoptionTarget> {
    const target = await this.resolveTarget(args.skillName, args.nodeId);
    await this.materializeSkillHome(
      { id: existing.id, dataPath: existing.dataPath, nodeId: target.nodeId },
      target.skill,
      target.runtimeMode,
    );
    return target;
  }

  async adoptLocalTree(args: AdoptLocalTreeArgs): Promise<AdoptLocalTreeResult> {
    const home = this.allocateHome();
    await this.ensureJailDirs({ ...home, nodeId: args.nodeId });
    const copiedBytes = this.stageExternalTreeIntoGame(args.sourcePath, home.dataPath);
    this.writeMarker(home.dataPath, args.skill, args.runtimeMode, args.nodeId, args.markerExtras);

    await this.insertServerRow({
      id: home.id,
      name: args.serverName,
      game: args.gameLabel,
      nodeId: args.nodeId,
      runtimeMode: args.runtimeMode,
      dataPath: home.dataPath,
    });

    const baseline = await this.createBaseline(home.id, args.baselineLabel ?? "baseline-import");
    const server = await this.peekServer(home.id);
    if (!server) throw new Error(`server_missing_after_import: ${home.id}`);

    return {
      server,
      baselineSnapshotId: baseline.id,
      copiedBytes,
      id: home.id,
      dataPath: home.dataPath,
    };
  }

  /**
   * Manage cutover Home half: allocate, ensure dirs, marker + node-authoritative flag, insert DB.
   * Caller keeps manage_seed / manage_cutover / node fs writes / baseline.
   */
  async beginManagedAdopt(args: BeginManagedAdoptArgs): Promise<AllocatedServerHome> {
    const nodeId = requireNodeId(args.nodeId, "manage");
    const home = this.allocateHome();
    await this.materializeSkillHome(
      { ...home, nodeId },
      args.skill,
      args.runtimeMode,
      {
        managedFrom: args.managedFrom,
        managedAt: new Date().toISOString(),
        nodeAuthoritative: true,
      },
    );
    this.writeNodeAuthoritativeMarker(home.dataPath, nodeId);

    await this.insertServerRow({
      id: home.id,
      name: args.serverName,
      game: args.gameLabel,
      nodeId,
      runtimeMode: args.runtimeMode,
      dataPath: home.dataPath,
    });

    return home;
  }
}
