import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";
import type { ServerService } from "./servers.js";
import { ServerFileStoreError, type ServerFileStore } from "./server-file-store.js";

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
const MAX_ENTRY_COUNT = 10_000;

export type ArchiveFormat = "zip" | "tar.gz";

function detectFormat(archivePath: string): ArchiveFormat {
  const lower = archivePath.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
  if (lower.endsWith(".zip")) return "zip";
  throw new Error("unsupported_archive_format");
}

function stripEntryPath(entryPath: string, stripComponents: number): string | null {
  const normalized = entryPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.endsWith("/")) return null;
  const parts = normalized.split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === "..")) {
    throw new Error(`archive_path_escape: ${entryPath}`);
  }
  if (parts.length <= stripComponents) return null;
  return parts.slice(stripComponents).join("/");
}

function runTarExtract(archive: string, destDir: string, timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xzf", archive, "-C", destDir], {
      cwd: destDir,
      shell: false,
      windowsHide: true,
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("archive_extract_timeout"));
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`archive_extract_failed: ${(stderr || `exit ${code}`).slice(-300)}`));
    });
  });
}

/** Test helper: build a zip buffer from path→content map. */
export function buildTestZip(files: Record<string, string | Uint8Array>): Uint8Array {
  const encoded: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) {
    encoded[name] = typeof content === "string" ? new TextEncoder().encode(content) : content;
  }
  return zipSync(encoded);
}

function joinServerRel(destDir: string, rel: string): string {
  const base = destDir.replace(/\\/g, "/").replace(/^\.\/?/, "").replace(/\/+$/, "");
  if (!base || base === ".") return rel;
  return `${base}/${rel}`;
}

export class ServerArchiveService {
  constructor(private readonly servers: ServerService) {}

  async extract(args: {
    serverId: string;
    archivePath: string;
    destDir: string;
    stripComponents?: number;
  }): Promise<{ extracted: number; destDir: string; format: ArchiveFormat }> {
    const store = await this.servers.files(args.serverId);
    const strip = Math.max(0, Math.floor(args.stripComponents ?? 0));
    const format = detectFormat(args.archivePath);

    const archived = await store.readBytes(args.archivePath);
    if (archived.size > MAX_ARCHIVE_BYTES) {
      throw new Error("archive_too_large");
    }

    await store.ensureDir(args.destDir);

    if (format === "zip") {
      const extracted = await this.extractZipToStore(archived.data, store, args.destDir, strip);
      return { extracted, destDir: args.destDir, format };
    }

    const extracted = await this.extractTarGzToStore(archived.data, store, args.destDir, strip);
    return { extracted, destDir: args.destDir, format };
  }

  private async extractZipToStore(
    zipBytes: Buffer,
    store: ServerFileStore,
    destDir: string,
    stripComponents: number,
  ): Promise<number> {
    const files = unzipSync(new Uint8Array(zipBytes));
    const names = Object.keys(files);
    if (names.length > MAX_ENTRY_COUNT) {
      throw new Error("archive_too_many_entries");
    }

    let uncompressed = 0;
    let extracted = 0;
    for (const name of names) {
      const data = files[name];
      if (!data) continue;
      if (name.endsWith("/")) continue;
      const rel = stripEntryPath(name, stripComponents);
      if (rel === null) continue;
      uncompressed += data.byteLength;
      if (uncompressed > MAX_UNCOMPRESSED_BYTES) {
        throw new Error("archive_uncompressed_too_large");
      }
      const targetRel = joinServerRel(destDir, rel);
      const parent = path.posix.dirname(targetRel.replace(/\\/g, "/"));
      if (parent && parent !== ".") await store.ensureDir(parent);
      await store.writeBytes(targetRel, Buffer.from(data));
      extracted += 1;
    }
    return extracted;
  }

  private async extractTarGzToStore(
    archiveBytes: Buffer,
    store: ServerFileStore,
    destDir: string,
    stripComponents: number,
  ): Promise<number> {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "playon-tar-"));
    try {
      const archivePath = path.join(staging, "in.tgz");
      fs.writeFileSync(archivePath, archiveBytes);
      const extractRoot = path.join(staging, "out");
      fs.mkdirSync(extractRoot, { recursive: true });
      await runTarExtract(archivePath, extractRoot);

      let uncompressed = 0;
      let entryCount = 0;
      let extracted = 0;

      const copyIn = async (fromDir: string, relBase: string) => {
        for (const name of fs.readdirSync(fromDir)) {
          const from = path.join(fromDir, name);
          const st = fs.lstatSync(from);
          const rel = relBase ? `${relBase}/${name}` : name;
          if (st.isSymbolicLink()) {
            throw new Error(`archive_symlink_rejected: ${rel}`);
          }
          if (st.isDirectory()) {
            await copyIn(from, rel);
            continue;
          }
          entryCount += 1;
          if (entryCount > MAX_ENTRY_COUNT) throw new Error("archive_too_many_entries");
          uncompressed += st.size;
          if (uncompressed > MAX_UNCOMPRESSED_BYTES) {
            throw new Error("archive_uncompressed_too_large");
          }
          const stripped = stripEntryPath(rel, stripComponents);
          if (stripped === null) continue;
          const targetRel = joinServerRel(destDir, stripped);
          const parent = path.posix.dirname(targetRel.replace(/\\/g, "/"));
          if (parent && parent !== ".") await store.ensureDir(parent);
          await store.writeBytes(targetRel, fs.readFileSync(from));
          extracted += 1;
        }
      };
      await copyIn(extractRoot, "");
      return extracted;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
}

export function archiveStoreErrorMessage(err: unknown): string {
  if (err instanceof ServerFileStoreError) return err.message;
  return err instanceof Error ? err.message : "archive_extract_failed";
}
