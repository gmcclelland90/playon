import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { snapshots } from "../db/schema.js";
import type { ServerRecord } from "./servers.js";
import { ServerService } from "./servers.js";

export interface SnapshotRecord {
  id: string;
  serverId: string;
  label: string;
  path: string;
  createdAt: Date;
}

/** Quick/scheduled snapshots are retained; durable backups & baselines are kept. */
export type SnapshotRetentionPolicy = {
  maxCount: number;
  maxAgeHours: number;
};

export const DEFAULT_SNAPSHOT_RETENTION: SnapshotRetentionPolicy = {
  maxCount: 10,
  maxAgeHours: 72,
};

export function isDurableSnapshotLabel(label: string): boolean {
  const lower = label.toLowerCase();
  return (
    lower.startsWith("baseline") ||
    lower.startsWith("backup") ||
    lower.startsWith("pre-restore") ||
    lower.includes("durable")
  );
}

function toRecord(row: typeof snapshots.$inferSelect): SnapshotRecord {
  return {
    id: row.id,
    serverId: row.serverId,
    label: row.label,
    path: row.path,
    createdAt: row.createdAt,
  };
}

export class SnapshotService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly servers: ServerService,
  ) {}

  async list(serverId?: string): Promise<SnapshotRecord[]> {
    const rows = serverId
      ? await this.db.select().from(snapshots).where(eq(snapshots.serverId, serverId))
      : await this.db.select().from(snapshots);
    return rows.map(toRecord).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async get(id: string): Promise<SnapshotRecord | null> {
    const rows = await this.db.select().from(snapshots).where(eq(snapshots.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async create(serverId: string, label: string): Promise<SnapshotRecord> {
    const server = await this.servers.get(serverId);
    if (!server) throw new Error(`unknown_server: ${serverId}`);
    if (!fs.existsSync(server.dataPath)) {
      throw new Error(`server_data_missing: ${server.dataPath}`);
    }

    const snapshotId = nanoid();
    const snapshotPath = path.join(this.config.dataRoot, "snapshots", snapshotId);
    const filesPath = path.join(snapshotPath, "files");
    fs.mkdirSync(filesPath, { recursive: true });
    fs.cpSync(server.dataPath, filesPath, { recursive: true });

    const manifest = {
      serverId,
      label,
      source: server.dataPath,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(snapshotPath, "SNAPSHOT"), JSON.stringify(manifest, null, 2));

    const now = new Date();
    await this.db.insert(snapshots).values({
      id: snapshotId,
      serverId,
      label,
      path: snapshotPath,
      createdAt: now,
    });

    return (await this.get(snapshotId))!;
  }

  async restore(snapshotId: string): Promise<ServerRecord> {
    const snapshot = await this.get(snapshotId);
    if (!snapshot) throw new Error(`unknown_snapshot: ${snapshotId}`);

    const server = await this.servers.get(snapshot.serverId);
    if (!server) throw new Error(`unknown_server: ${snapshot.serverId}`);

    const filesPath = path.join(snapshot.path, "files");
    if (!fs.existsSync(filesPath)) {
      throw new Error(`snapshot_files_missing: ${filesPath}`);
    }

    if (server.status === "running") {
      await this.servers.stop(server.id);
    }

    const tempBackup = fs.mkdtempSync(path.join(os.tmpdir(), "playon-restore-"));
    try {
      if (fs.existsSync(server.dataPath)) {
        fs.cpSync(server.dataPath, tempBackup, { recursive: true });
      }

      fs.rmSync(server.dataPath, { recursive: true, force: true });
      fs.mkdirSync(server.dataPath, { recursive: true });
      fs.cpSync(filesPath, server.dataPath, { recursive: true });
    } catch (err) {
      if (fs.existsSync(tempBackup)) {
        fs.rmSync(server.dataPath, { recursive: true, force: true });
        fs.cpSync(tempBackup, server.dataPath, { recursive: true });
      }
      throw err;
    } finally {
      fs.rmSync(tempBackup, { recursive: true, force: true });
    }

    return (await this.servers.get(server.id))!;
  }

  async remove(id: string): Promise<boolean> {
    const snapshot = await this.get(id);
    if (!snapshot) return false;
    fs.rmSync(snapshot.path, { recursive: true, force: true });
    await this.db.delete(snapshots).where(eq(snapshots.id, id));
    return true;
  }

  /**
   * Drop older quick/scheduled snapshots past count or age.
   * Durable labels (baseline/backup/…) are never auto-deleted.
   */
  async enforceRetention(
    serverId?: string,
    policy: SnapshotRetentionPolicy = DEFAULT_SNAPSHOT_RETENTION,
  ): Promise<{ removed: string[] }> {
    const all = await this.list(serverId);
    const eligible = all.filter((s) => !isDurableSnapshotLabel(s.label));
    const cutoff = Date.now() - policy.maxAgeHours * 60 * 60 * 1000;
    const removed: string[] = [];

    for (const snap of eligible) {
      if (snap.createdAt.getTime() < cutoff) {
        if (await this.remove(snap.id)) removed.push(snap.id);
      }
    }

    const remaining = (await this.list(serverId)).filter((s) => !isDurableSnapshotLabel(s.label));
    if (remaining.length > policy.maxCount) {
      const overflow = remaining.slice(policy.maxCount);
      for (const snap of overflow) {
        if (await this.remove(snap.id)) removed.push(snap.id);
      }
    }

    return { removed };
  }

  /** Create a scheduled snapshot for every running server, then enforce retention. */
  async runScheduledPass(
    policy: SnapshotRetentionPolicy = DEFAULT_SNAPSHOT_RETENTION,
  ): Promise<{ created: string[]; removed: string[] }> {
    const servers = await this.servers.list();
    const created: string[] = [];
    const removed: string[] = [];
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");

    for (const server of servers) {
      if (server.status !== "running") continue;
      try {
        const snap = await this.create(server.id, `scheduled-${stamp}`);
        created.push(snap.id);
        const pruned = await this.enforceRetention(server.id, policy);
        removed.push(...pruned.removed);
      } catch {
        // keep pass best-effort per server
      }
    }

    return { created, removed };
  }
}

/** Create a pre-change snapshot, run an operation, and return its result. */
export async function withSnapshot<T>(
  service: SnapshotService,
  serverId: string,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  await service.create(serverId, label);
  return fn();
}
