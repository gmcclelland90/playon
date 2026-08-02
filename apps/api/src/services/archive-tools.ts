import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";
import { PathJailError, resolveInJail } from "@playon/runtime";
import type { ServerService } from "./servers.js";

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

function assertUnderJail(root: string, target: string): void {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new PathJailError(`path escapes jail: ${target}`);
  }
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

export class ServerArchiveService {
  constructor(private readonly servers: ServerService) {}

  async extract(args: {
    serverId: string;
    archivePath: string;
    destDir: string;
    stripComponents?: number;
  }): Promise<{ extracted: number; destDir: string; format: ArchiveFormat }> {
    const server = await this.servers.get(args.serverId);
    if (!server) throw new Error(`unknown_server: ${args.serverId}`);

    const strip = Math.max(0, Math.floor(args.stripComponents ?? 0));
    const archiveAbs = resolveInJail(server.dataPath, args.archivePath);
    const destAbs = resolveInJail(server.dataPath, args.destDir);

    if (!fs.existsSync(archiveAbs) || !fs.statSync(archiveAbs).isFile()) {
      throw new Error(`not_found: ${args.archivePath}`);
    }
    const archiveSize = fs.statSync(archiveAbs).size;
    if (archiveSize > MAX_ARCHIVE_BYTES) {
      throw new Error("archive_too_large");
    }

    const format = detectFormat(args.archivePath);
    fs.mkdirSync(destAbs, { recursive: true });

    if (format === "zip") {
      const extracted = this.extractZip(archiveAbs, destAbs, server.dataPath, strip);
      return { extracted, destDir: args.destDir, format };
    }

    const extracted = await this.extractTarGz(archiveAbs, destAbs, server.dataPath, strip);
    return { extracted, destDir: args.destDir, format };
  }

  private extractZip(
    archiveAbs: string,
    destAbs: string,
    jailRoot: string,
    stripComponents: number,
  ): number {
    const zipBytes = fs.readFileSync(archiveAbs);
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
      // Directory markers often end with /
      if (name.endsWith("/")) continue;
      const rel = stripEntryPath(name, stripComponents);
      if (rel === null) continue;
      uncompressed += data.byteLength;
      if (uncompressed > MAX_UNCOMPRESSED_BYTES) {
        throw new Error("archive_uncompressed_too_large");
      }
      const target = resolveInJail(destAbs, rel);
      assertUnderJail(jailRoot, target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      extracted += 1;
    }
    return extracted;
  }

  private async extractTarGz(
    archiveAbs: string,
    destAbs: string,
    jailRoot: string,
    stripComponents: number,
  ): Promise<number> {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "playon-tar-"));
    try {
      await runTarExtract(archiveAbs, staging);

      let uncompressed = 0;
      let entryCount = 0;
      let extracted = 0;

      const copyIn = (fromDir: string, relBase: string) => {
        for (const name of fs.readdirSync(fromDir)) {
          const from = path.join(fromDir, name);
          const st = fs.lstatSync(from);
          const rel = relBase ? `${relBase}/${name}` : name;
          if (st.isSymbolicLink()) {
            throw new Error(`archive_symlink_rejected: ${rel}`);
          }
          if (st.isDirectory()) {
            copyIn(from, rel);
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
          const target = resolveInJail(destAbs, stripped);
          assertUnderJail(jailRoot, target);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(from, target);
          extracted += 1;
        }
      };
      copyIn(staging, "");
      return extracted;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
}
