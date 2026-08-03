import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { servers } from "../db/schema.js";
import type { EventHub } from "./event-hub.js";
import { PlacementService } from "./placement.js";
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
 * Best-effort relocate: stop → snapshot → rebind nodeId → start on control plane.
 * Remote Docker execution is not available yet; any eligible online node may receive
 * the binding, and runtime always runs on the API host for now.
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
    return {
      server: updated,
      fromNodeId,
      toNodeId,
      snapshotId: snap.id,
      restarted,
      note: "rebound_control_plane_runtime",
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
