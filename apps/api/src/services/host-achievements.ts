import { and, count, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { hostAchievements, nodes, servers } from "../db/schema.js";

export type AchievementDef = {
  id: string;
  title: string;
  description: string;
};

export const ACHIEVEMENT_CATALOG: AchievementDef[] = [
  {
    id: "first_server",
    title: "Lights On",
    description: "Create your first PlayOn server.",
  },
  {
    id: "first_start",
    title: "Boot Sequence",
    description: "Start a server successfully.",
  },
  {
    id: "first_import",
    title: "Bring Your Own World",
    description: "Import an existing server from disk or SFTP.",
  },
  {
    id: "first_restore",
    title: "Undo Button",
    description: "Restore a server from a snapshot or off-node backup.",
  },
  {
    id: "first_offnode_backup",
    title: "Spare Drive",
    description: "Copy a durable backup to an off-node target.",
  },
  {
    id: "first_modded",
    title: "First Modded Server",
    description: "Run a server skill tagged for mods/plugins.",
  },
  {
    id: "zero_downtime_lan",
    title: "Zero-Downtime LAN",
    description: "Keep two or more servers running at once.",
  },
  {
    id: "multi_node",
    title: "Fleet Captain",
    description: "Register a remote node alongside the control plane.",
  },
];

export type AchievementUnlock = AchievementDef & { unlockedAt: Date };

export type AchievementEvent =
  | { type: "server_created"; skillTags?: string[]; skillName?: string }
  | { type: "server_started" }
  | { type: "server_imported"; skillTags?: string[]; skillName?: string; hints?: string[] }
  | { type: "server_restored" }
  | { type: "offnode_backup" }
  | { type: "tools"; toolNames: string[]; skillHints?: string[] };

export function looksModded(input: {
  skillTags?: string[];
  skillName?: string;
  hints?: string[];
}): boolean {
  if (input.hints?.some((h) => /mod|plugin/i.test(h))) return true;
  const blob = [...(input.skillTags ?? []), input.skillName ?? ""].join(" ");
  return /mod|plugin|paper|forge|fabric|spigot|bukkit/i.test(blob);
}

export class HostAchievementService {
  constructor(private readonly db: Db) {}

  catalog(): AchievementDef[] {
    return ACHIEVEMENT_CATALOG;
  }

  async listForUser(userId: string): Promise<{
    unlocked: AchievementUnlock[];
    locked: AchievementDef[];
  }> {
    const rows = await this.db
      .select()
      .from(hostAchievements)
      .where(eq(hostAchievements.userId, userId));
    const byId = new Map(rows.map((r) => [r.achievementId, r.unlockedAt]));
    const unlocked: AchievementUnlock[] = [];
    const locked: AchievementDef[] = [];
    for (const def of ACHIEVEMENT_CATALOG) {
      const at = byId.get(def.id);
      if (at) unlocked.push({ ...def, unlockedAt: at });
      else locked.push(def);
    }
    unlocked.sort((a, b) => b.unlockedAt.getTime() - a.unlockedAt.getTime());
    return { unlocked, locked };
  }

  async unlock(userId: string, achievementId: string): Promise<AchievementUnlock | null> {
    const def = ACHIEVEMENT_CATALOG.find((a) => a.id === achievementId);
    if (!def) return null;
    const existing = await this.db
      .select()
      .from(hostAchievements)
      .where(
        and(
          eq(hostAchievements.userId, userId),
          eq(hostAchievements.achievementId, achievementId),
        ),
      )
      .limit(1);
    if (existing[0]) return null;
    const unlockedAt = new Date();
    await this.db.insert(hostAchievements).values({
      userId,
      achievementId,
      unlockedAt,
    });
    return { ...def, unlockedAt };
  }

  private async runningCount(): Promise<number> {
    const running = await this.db
      .select({ value: count() })
      .from(servers)
      .where(eq(servers.status, "running"));
    return running[0]?.value ?? 0;
  }

  async evaluate(userId: string, event: AchievementEvent): Promise<AchievementUnlock[]> {
    const fresh: AchievementUnlock[] = [];
    const tryUnlock = async (id: string) => {
      const u = await this.unlock(userId, id);
      if (u) fresh.push(u);
    };

    if (event.type === "server_created") {
      await tryUnlock("first_server");
      if (looksModded(event)) await tryUnlock("first_modded");
    }
    if (event.type === "server_imported") {
      await tryUnlock("first_import");
      await tryUnlock("first_server");
      if (looksModded(event)) await tryUnlock("first_modded");
    }
    if (event.type === "server_started") {
      await tryUnlock("first_start");
      if ((await this.runningCount()) >= 2) await tryUnlock("zero_downtime_lan");
    }
    if (event.type === "server_restored") await tryUnlock("first_restore");
    if (event.type === "offnode_backup") await tryUnlock("first_offnode_backup");

    if (event.type === "tools") {
      const names = new Set(event.toolNames);
      if (
        names.has("servers_create_from_skill") ||
        names.has("servers_import_local") ||
        names.has("servers_import_sftp")
      ) {
        await tryUnlock("first_server");
      }
      if (names.has("servers_import_local") || names.has("servers_import_sftp")) {
        await tryUnlock("first_import");
      }
      if (names.has("servers_start") || names.has("servers_restart")) {
        await tryUnlock("first_start");
        if ((await this.runningCount()) >= 2) await tryUnlock("zero_downtime_lan");
      }
      if (names.has("snapshot_restore") || names.has("backup_offnode_restore")) {
        await tryUnlock("first_restore");
      }
      if (names.has("backup_offnode")) await tryUnlock("first_offnode_backup");
      if (looksModded({ skillTags: event.skillHints, hints: event.skillHints })) {
        await tryUnlock("first_modded");
      }
    }

    const nodeRows = await this.db.select().from(nodes);
    if (nodeRows.some((n) => n.id !== "local")) {
      await tryUnlock("multi_node");
    }

    return fresh;
  }
}
