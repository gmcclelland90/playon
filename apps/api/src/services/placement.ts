import os from "node:os";
import { eq } from "drizzle-orm";
import { deriveNodePresence, LOCAL_NODE_ID, type NodePresence, type SkillMetadata } from "@playon/shared";
import { probeHostCapabilities } from "@playon/runtime";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { nodes } from "../db/schema.js";
import { loadSkillMetadata } from "./skills.js";
import type { NetToolsService } from "./net-tools.js";

const MIN_DISK_BYTES = 512 * 1024 * 1024;

export type PlacementCandidate = {
  nodeId: string;
  name: string;
  os: "linux" | "windows";
  docker: boolean;
  native: boolean;
  steamcmd: boolean;
  freeDiskBytes: number | null;
  status: NodePresence;
  eligible: boolean;
  score: number;
  reasons: string[];
};

export type PlacementPlan = {
  skillName: string;
  recommendedNodeId: string | null;
  candidates: PlacementCandidate[];
};

export type NodeCaps = {
  id: string;
  name: string;
  os: "linux" | "windows";
  docker: boolean;
  native: boolean;
  steamcmd: boolean;
  freeDiskBytes: number | null;
  lastSeenAt: Date;
};

export function scoreNodeForSkill(
  node: NodeCaps,
  skill: SkillMetadata,
  nowMs: number = Date.now(),
  opts?: { relaxDocker?: boolean },
): PlacementCandidate {
  const status = deriveNodePresence(node.lastSeenAt, nowMs);
  const reasons: string[] = [];
  let eligible = true;
  let score = 0;

  if (status === "offline") {
    eligible = false;
    reasons.push("node_offline");
  } else if (status === "stale") {
    score -= 20;
    reasons.push("node_stale");
  } else {
    score += 40;
    reasons.push("node_online");
  }

  if (!skill.os.includes(node.os)) {
    eligible = false;
    reasons.push(`os_mismatch:${node.os}`);
  } else {
    score += 25;
    reasons.push(`os_ok:${node.os}`);
  }

  const needsDocker = skill.containerSupport === "full" && !opts?.relaxDocker;
  const prefersDocker = skill.containerSupport === "partial" || skill.containerSupport === "full";
  const needsNative =
    skill.containerSupport === "none" || (skill.steamAppId != null && !needsDocker);

  if (needsDocker && !node.docker) {
    eligible = false;
    reasons.push("docker_required");
  } else if (prefersDocker && (node.docker || opts?.relaxDocker)) {
    score += 20;
    reasons.push(node.docker ? "docker_ready" : "docker_relaxed");
  }

  if (needsNative) {
    if (!node.native) {
      eligible = false;
      reasons.push("native_required");
    } else {
      score += 10;
      reasons.push("native_ok");
    }
  }

  if (skill.steamAppId != null) {
    if (!node.steamcmd) {
      eligible = false;
      reasons.push("steamcmd_required");
    } else {
      score += 15;
      reasons.push("steamcmd_ok");
    }
  }

  if (node.freeDiskBytes != null) {
    if (node.freeDiskBytes < MIN_DISK_BYTES) {
      eligible = false;
      reasons.push("disk_low");
    } else {
      const gib = node.freeDiskBytes / 1024 ** 3;
      score += Math.min(30, Math.floor(gib * 3));
      reasons.push(`disk_ok:${gib.toFixed(1)}GiB`);
    }
  } else {
    reasons.push("disk_unknown");
  }

  return {
    nodeId: node.id,
    name: node.name,
    os: node.os,
    docker: node.docker,
    native: node.native,
    steamcmd: node.steamcmd,
    freeDiskBytes: node.freeDiskBytes,
    status,
    eligible,
    score: eligible ? score : score - 1000,
    reasons,
  };
}

export class PlacementService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly net?: NetToolsService,
  ) {}

  /** Ensure a durable `local` control-plane row exists for FK placement. */
  async ensureLocalNode(): Promise<NodeCaps> {
    const now = new Date();
    const probed = probeHostCapabilities(this.config.dataRoot);
    // Host PLAYON_RUNTIME=native means we will not use Docker even if the socket exists.
    const docker = this.config.runtimeMode === "docker" && probed.docker;
    const local: NodeCaps = {
      id: LOCAL_NODE_ID,
      name: os.hostname() || "local",
      os: probed.os,
      docker,
      native: probed.native,
      steamcmd: probed.steamcmd,
      freeDiskBytes: probed.freeDiskBytes ?? null,
      lastSeenAt: now,
    };
    const existing = await this.db.select().from(nodes).where(eq(nodes.id, LOCAL_NODE_ID)).limit(1);
    if (existing[0]) {
      await this.db
        .update(nodes)
        .set({
          name: local.name,
          os: local.os,
          docker: local.docker,
          native: local.native,
          steamcmd: local.steamcmd,
          freeDiskBytes: local.freeDiskBytes,
          lastSeenAt: now,
        })
        .where(eq(nodes.id, LOCAL_NODE_ID));
      return local;
    }
    await this.db.insert(nodes).values({
      id: local.id,
      name: local.name,
      os: local.os,
      docker: local.docker,
      native: local.native,
      steamcmd: local.steamcmd,
      freeDiskBytes: local.freeDiskBytes,
      agentVersion: "control-plane",
      lastSeenAt: now,
    });
    return local;
  }

  private async listNodeCaps(): Promise<NodeCaps[]> {
    await this.ensureLocalNode();
    const rows = await this.db.select().from(nodes);
    return rows.map((n) => ({
      id: n.id,
      name: n.name,
      os: n.os as "linux" | "windows",
      docker: n.docker,
      native: n.native ?? true,
      steamcmd: n.steamcmd ?? false,
      freeDiskBytes: n.freeDiskBytes,
      lastSeenAt: n.lastSeenAt,
    }));
  }

  async plan(skillName: string): Promise<PlacementPlan> {
    const skill = loadSkillMetadata(this.config.skillsRoots, skillName);
    if (!skill) throw new Error(`unknown_skill: ${skillName}`);

    const caps = await this.listNodeCaps();
    const candidates = caps
      .map((n) => scoreNodeForSkill(n, skill.metadata, Date.now()))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    if (this.net && candidates[0]?.eligible) {
      const preferred = skill.metadata.ports.find((p) => p.default)?.default;
      if (preferred) {
        try {
          const bind = await this.net.suggestBind({ preferredPort: preferred });
          if (bind.available) {
            candidates[0]!.reasons.push(`port_ok:${bind.port}`);
            candidates[0]!.score += 5;
          } else {
            candidates[0]!.reasons.push(`port_busy:${preferred}`);
            candidates[0]!.score -= 5;
          }
        } catch {
          // ignore probe failures
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const recommended = candidates.find((c) => c.eligible) ?? null;

    return {
      skillName: skill.metadata.name,
      recommendedNodeId: recommended?.nodeId ?? null,
      candidates,
    };
  }

  async resolveNodeId(skillName: string, requested?: string): Promise<string | null> {
    const plan = await this.plan(skillName);
    if (requested) {
      const hit = plan.candidates.find((c) => c.nodeId === requested);
      if (!hit) throw new Error(`unknown_node: ${requested}`);
      if (!hit.eligible) {
        throw new Error(`node_ineligible: ${requested} (${hit.reasons.join(",")})`);
      }
      return hit.nodeId;
    }
    return plan.recommendedNodeId;
  }
}
