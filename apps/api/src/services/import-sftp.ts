import fs from "node:fs";
import path from "node:path";
import { Client, type SFTPWrapper } from "ssh2";
import { nanoid } from "nanoid";
import type { AppConfig } from "../config.js";
import {
  ImportLocalService,
  type ImportLocalArgs,
  type ImportLocalReport,
} from "./import-local.js";

export type SftpImportArgs = {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  remotePath: string;
  readyTimeoutMs?: number;
} & Omit<ImportLocalArgs, "sourcePath">;

export type SftpImportReport = ImportLocalReport & {
  stagedPath: string;
  remoteHost: string;
  remotePath: string;
};

export type SftpDownloader = (args: {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  remotePath: string;
  localPath: string;
  readyTimeoutMs: number;
}) => Promise<void>;

function downloadDir(
  sftp: SFTPWrapper,
  remoteDir: string,
  localDir: string,
): Promise<void> {
  fs.mkdirSync(localDir, { recursive: true });
  return new Promise((resolve, reject) => {
    sftp.readdir(remoteDir, (err, list) => {
      if (err) return reject(err);
      const entries = list ?? [];
      let i = 0;
      const next = () => {
        if (i >= entries.length) return resolve();
        const entry = entries[i++]!;
        const remote = `${remoteDir.replace(/\/$/, "")}/${entry.filename}`;
        const local = path.join(localDir, entry.filename);
        const isDir = (entry.attrs.mode & 0o170000) === 0o040000;
        if (isDir) {
          downloadDir(sftp, remote, local).then(next).catch(reject);
        } else {
          sftp.fastGet(remote, local, (getErr) => {
            if (getErr) reject(getErr);
            else next();
          });
        }
      };
      next();
    });
  });
}

export const defaultSftpDownloader: SftpDownloader = (args) =>
  new Promise((resolve, reject) => {
    const conn = new Client();
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error("sftp_timeout"));
    }, args.readyTimeoutMs);

    conn
      .on("ready", () => {
        conn.sftp((err, sftp) => {
          if (err || !sftp) {
            clearTimeout(timer);
            conn.end();
            return reject(err ?? new Error("sftp_unavailable"));
          }
          downloadDir(sftp, args.remotePath, args.localPath)
            .then(() => {
              clearTimeout(timer);
              conn.end();
              resolve();
            })
            .catch((downloadErr) => {
              clearTimeout(timer);
              conn.end();
              reject(downloadErr);
            });
        });
      })
      .on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      })
      .connect({
        host: args.host,
        port: args.port,
        username: args.username,
        password: args.password,
        privateKey: args.privateKey,
        readyTimeout: args.readyTimeoutMs,
      });
  });

export class ImportSftpService {
  constructor(
    private readonly config: AppConfig,
    private readonly importLocal: ImportLocalService,
    private readonly download: SftpDownloader = defaultSftpDownloader,
  ) {}

  async importFromSftp(args: SftpImportArgs): Promise<SftpImportReport> {
    if (!args.host?.trim()) throw new Error("host_required");
    if (!args.username?.trim()) throw new Error("username_required");
    if (!args.remotePath?.trim()) throw new Error("remote_path_required");
    if (!args.password && !args.privateKey) {
      throw new Error("password_or_private_key_required");
    }

    const stageId = nanoid();
    const stagedPath = path.join(this.config.dataRoot, "imports", stageId);
    fs.mkdirSync(stagedPath, { recursive: true });

    try {
      await this.download({
        host: args.host.trim(),
        port: args.port && args.port > 0 ? args.port : 22,
        username: args.username.trim(),
        password: args.password,
        privateKey: args.privateKey,
        remotePath: args.remotePath.trim(),
        localPath: stagedPath,
        readyTimeoutMs: args.readyTimeoutMs ?? 20_000,
      });

      const report = await this.importLocal.importFromPath({
        sourcePath: stagedPath,
        serverName: args.serverName,
        skillName: args.skillName,
        game: args.game,
        nodeId: args.nodeId,
      });

      report.followUp = [
        "imported_via_sftp",
        `remote:${args.host}:${args.remotePath}`,
        ...report.followUp,
      ];

      return {
        ...report,
        stagedPath,
        remoteHost: args.host.trim(),
        remotePath: args.remotePath.trim(),
      };
    } catch (err) {
      fs.rmSync(stagedPath, { recursive: true, force: true });
      throw err;
    }
  }
}
