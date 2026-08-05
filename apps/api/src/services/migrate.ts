import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { isLocalNodeId } from "@playon/shared";
import type { Db } from "../db/client.js";
import { nodes, servers } from "../db/schema.js";
import type { EventHub } from "./event-hub.js";
import { PlacementService } from "./placement.js";
import { pullServerDirFromNode, pushServerDirToNode } from "./node-sync.js";
import type { ServerRecord, ServerService } from "./servers.js";
import { readSkillMarker } from "./skill-marker.js";
import type { SnapshotService } from "./snapshots.js";

export type RelocateResult = {
  server: ServerRecord;
  fromNodeId: string | null;
  toNodeId: string;
  snapshotId: string;
  /** True when the control plane restarted the process after the move. */
  restarted: boolean;
  note: string;
};

/**
 * Relocate: stop → snapshot → sync server dir → rebind nodeId → start.
 */
export class MigrateService {
  constructor(
    private readonly db: Db,
    private readonly servers: ServerService,
    private readonly snapshots: SnapshotService,
    private readonly placement: PlacementService,
    private readonly events?: EventHub,
  ) {}

  async relocate(serverId: string, targetNodeId: string): Promise<RelocateResult> {
    const server = await this.servers.get(serverId);
    if (!server) throw new Error(`unknown_server: ${serverId}`);

    const skillName = this.readSkillName(server.dataPath);
    if (!skillName) throw new Error("server_skill_unknown");

    const toNodeId = await this.placement.resolveNodeId(skillName, targetNodeId);
    if (!toNodeId) throw new Error("no_eligible_node");

    const fromNodeId = server.nodeId;
    if (fromNodeId === toNodeId) {
      return {
        server,
        fromNodeId,
        toNodeId,
        snapshotId: "",
        restarted: false,
        note: "already_on_target",
      };
    }

    const wasRunning = server.status === "running" || server.status === "starting";
    if (wasRunning) {
      await this.servers.stop(serverId);
    }

    const snap = await this.snapshots.create(serverId, `pre-relocate-${toNodeId}`);

    // Ensure control-plane copy is current when leaving a remote node.
    if (fromNodeId && !isLocalNodeId(fromNodeId)) {
      await pullServerDirFromNode({
        nodeId: fromNodeId,
        serverId,
        localDataPath: server.dataPath,
      });
    }

    // Push to remote/cloud target.
    if (!isLocalNodeId(toNodeId)) {
      await pushServerDirToNode({
        nodeId: toNodeId,
        serverId,
        localDataPath: server.dataPath,
      });
    }

    await this.db.update(servers).set({ nodeId: toNodeId }).where(eq(servers.id, serverId));
    this.writeSkillNode(server.dataPath, toNodeId);

    this.events?.publish({
      type: "server.relocated",
      serverId,
      fromNodeId,
      toNodeId,
    });

    let restarted = false;
    if (wasRunning) {
      await this.servers.start(serverId);
      restarted = true;
    }

    const updated = (await this.servers.get(serverId))!;
    const toKind =
      (
        await this.db.select().from(nodes).where(eq(nodes.id, toNodeId)).limit(1)
      )[0]?.kind ?? "lan";
    return {
      server: updated,
      fromNodeId,
      toNodeId,
      snapshotId: snap.id,
      restarted,
      note: `synced_to_${toKind}`,
    };
  }

  private readSkillName(dataPath: string): string | null {
    return readSkillMarker(dataPath)?.skillName ?? null;
  }

  private writeSkillNode(dataPath: string, nodeId: string): void {
    const skillPath = path.join(dataPath, "skill.json");
    try {
      const raw = JSON.parse(fs.readFileSync(skillPath, "utf8")) as Record<string, unknown>;
      raw.nodeId = nodeId;
      fs.writeFileSync(skillPath, JSON.stringify(raw, null, 2));
    } catch {
      // best-effort
    }
  }
}
