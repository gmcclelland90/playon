import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { snapshots } from "../db/schema.js";
import { getSetting, setSetting } from "./settings.js";
import type { SnapshotService } from "./snapshots.js";

export const BACKUP_TARGET_KEY = "backup.target";

export type BackupTargetSettings = {
  /** Absolute path to off-node / external backup root (USB, NAS mount, second disk). */
  rootPath: string;
};

export type OffNodeBackupRecord = {
  id: string;
  serverId: string;
  label: string;
  sourceSnapshotId: string;
  path: string;
  exportedAt: string;
};

type OffNodeManifest = {
  id: string;
  serverId: string;
  label: string;
  sourceSnapshotId: string;
  exportedAt: string;
};

function assertSafeRoot(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  if (!path.isAbsolute(resolved)) {
    throw new Error("backup_root_must_be_absolute");
  }
  return resolved;
}

export class OffNodeBackupService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly snapshots: SnapshotService,
  ) {}

  async getTarget(): Promise<string | null> {
    const stored = await getSetting<BackupTargetSettings>(this.db, BACKUP_TARGET_KEY);
    const fromSettings = stored?.rootPath?.trim();
    const fromEnv = this.config.backupRoot?.trim();
    const root = fromSettings || fromEnv || "";
    return root ? assertSafeRoot(root) : null;
  }

  async setTarget(rootPath: string): Promise<{ rootPath: string }> {
    const root = assertSafeRoot(rootPath);
    fs.mkdirSync(root, { recursive: true });
    await setSetting(this.db, BACKUP_TARGET_KEY, { rootPath: root } satisfies BackupTargetSettings);
    return { rootPath: root };
  }

  async exportSnapshot(snapshotId: string): Promise<OffNodeBackupRecord> {
    const root = await this.getTarget();
    if (!root) throw new Error("backup_target_not_configured");

    const snap = await this.snapshots.get(snapshotId);
    if (!snap) throw new Error(`unknown_snapshot: ${snapshotId}`);
    if (!fs.existsSync(snap.path)) throw new Error(`snapshot_missing: ${snapshotId}`);

    const id = nanoid();
    const dest = path.join(root, snap.serverId, id);
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(snap.path, dest, { recursive: true });

    const manifest: OffNodeManifest = {
      id,
      serverId: snap.serverId,
      label: snap.label.startsWith("backup") ? snap.label : `backup-${snap.label}`,
      sourceSnapshotId: snap.id,
      exportedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dest, "OFFNODE.json"), JSON.stringify(manifest, null, 2));

    return {
      id: manifest.id,
      serverId: manifest.serverId,
      label: manifest.label,
      sourceSnapshotId: manifest.sourceSnapshotId,
      path: dest,
      exportedAt: manifest.exportedAt,
    };
  }

  /** Create a durable local snapshot and immediately copy it off-node. */
  async backupServer(serverId: string, label?: string): Promise<OffNodeBackupRecord> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const snap = await this.snapshots.create(serverId, label ?? `backup-${stamp}`);
    return this.exportSnapshot(snap.id);
  }

  async list(serverId?: string): Promise<OffNodeBackupRecord[]> {
    const root = await this.getTarget();
    if (!root || !fs.existsSync(root)) return [];

    const out: OffNodeBackupRecord[] = [];
    const serverDirs = serverId
      ? [path.join(root, serverId)].filter((p) => fs.existsSync(p))
      : fs
          .readdirSync(root)
          .map((name) => path.join(root, name))
          .filter((p) => fs.statSync(p).isDirectory());

    for (const serverDir of serverDirs) {
      for (const name of fs.readdirSync(serverDir)) {
        const dir = path.join(serverDir, name);
        const manifestPath = path.join(dir, "OFFNODE.json");
        if (!fs.existsSync(manifestPath)) continue;
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as OffNodeManifest;
          out.push({
            id: manifest.id,
            serverId: manifest.serverId,
            label: manifest.label,
            sourceSnapshotId: manifest.sourceSnapshotId,
            path: dir,
            exportedAt: manifest.exportedAt,
          });
        } catch {
          // skip corrupt
        }
      }
    }

    return out.sort((a, b) => b.exportedAt.localeCompare(a.exportedAt));
  }

  /**
   * Copy an off-node backup back into the local snapshot store, then restore onto the server.
   */
  async restore(exportId: string, serverId?: string): Promise<{
    snapshotId: string;
    serverId: string;
  }> {
    const listed = await this.list();
    const record = listed.find((b) => b.id === exportId);
    if (!record) throw new Error(`unknown_offnode_backup: ${exportId}`);

    const targetServerId = serverId ?? record.serverId;
    const snapshotId = nanoid();
    const localPath = path.join(this.config.dataRoot, "snapshots", snapshotId);
    fs.mkdirSync(localPath, { recursive: true });
    fs.cpSync(record.path, localPath, { recursive: true });
    const marker = path.join(localPath, "OFFNODE.json");
    if (fs.existsSync(marker)) fs.rmSync(marker);

    await this.db.insert(snapshots).values({
      id: snapshotId,
      serverId: targetServerId,
      label: record.label,
      path: localPath,
      createdAt: new Date(),
    });

    await this.snapshots.restore(snapshotId);
    return { snapshotId, serverId: targetServerId };
  }
}
