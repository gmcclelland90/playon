import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PathJailError, resolveInJail } from "@playon/runtime";
import {
  FS_READ_MAX_BYTES,
  hasNodeJobErrorCode,
  isLocalNodeId,
  NODE_AUTHORITATIVE_MARKER,
  type NodeJobArgsInput,
  type NodeJobKind,
  type NodeJobResult,
} from "@playon/shared";
import { dispatchNodeJob, nodeServerRelPath } from "./node-runtime.js";

/** Locality override for callers that must sync onto a remote node before the marker exists. */
export type FileStoreLocalityMode = "auto" | "local" | "remote";

export type ServerFileStoreErrorCode =
  | "path_escape"
  | "not_found"
  | "is_directory"
  | "not_directory"
  | "already_exists"
  | "io_failed"
  | "node_unreachable"
  | "unknown_server";

export class ServerFileStoreError extends Error {
  readonly code: ServerFileStoreErrorCode;

  constructor(code: ServerFileStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ServerFileStoreError";
    this.code = code;
  }
}

export type ServerFileStoreServer = {
  id: string;
  nodeId: string | null;
  dataPath: string;
};

export type ServerFileStoreDeps = {
  /** Optional inject for tests; defaults to `dispatchNodeJob`. */
  dispatch?: typeof dispatchNodeJob;
};

export type ServerFileEntry = { name: string; type: "file" | "dir" };

export type ServerFileReadResult = {
  path: string;
  content: string;
  bytesRead: number;
  truncated: boolean;
  size: number;
};

/**
 * Path-jailed I/O for one game server's data directory. Callers never pick
 * local disk vs node jobs — the store does, from placement + the authoritative marker.
 */
export interface ServerFileStore {
  readonly serverId: string;
  readonly locality: "local" | "remote";
  list(relPath?: string): Promise<ServerFileEntry[]>;
  readText(
    relPath: string,
    opts?: { offset?: number; maxBytes?: number },
  ): Promise<ServerFileReadResult>;
  /** Binary-safe read used by archive extract; remote pulls a parent-dir tar. */
  readBytes(relPath: string): Promise<{ path: string; data: Buffer; size: number }>;
  writeText(relPath: string, content: string): Promise<{ path: string; bytes: number }>;
  /** Binary-safe write used by fetch/archive; remote packs a one-file tar. */
  writeBytes(relPath: string, data: Buffer): Promise<{ path: string; bytes: number }>;
  delete(relPath: string): Promise<{ path: string; deleted: "file" | "dir" }>;
  rename(
    fromPath: string,
    toPath: string,
    opts?: { overwrite?: boolean },
  ): Promise<{ from: string; to: string }>;
  copy(
    fromPath: string,
    toPath: string,
    opts?: { overwrite?: boolean },
  ): Promise<{ from: string; to: string }>;
  ensureDir(relPath: string): Promise<{ path: string; ok: boolean }>;
}

/**
 * Tool callers hand us free-form numbers (an LLM may send a float, a zero, or
 * nothing). The read contract wants sane integers, so clamp here rather than
 * failing validation on a window we can obviously repair.
 */
function readWindow(opts?: { offset?: number; maxBytes?: number }): {
  offset: number;
  maxBytes: number;
} {
  const rawOffset = Number(opts?.offset ?? 0);
  const rawMaxBytes = Number(opts?.maxBytes ?? FS_READ_MAX_BYTES);
  return {
    offset: Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0,
    maxBytes: Number.isFinite(rawMaxBytes)
      ? Math.min(FS_READ_MAX_BYTES, Math.max(1, Math.floor(rawMaxBytes)))
      : FS_READ_MAX_BYTES,
  };
}

function copyRecursive(src: string, dest: string): void {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyRecursive(path.join(src, name), path.join(dest, name));
    }
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/** Map a server-relative path onto the node jail (`servers/<id>/...`). */
export function nodeJailRel(serverId: string, relPath = "."): string {
  const cleaned = relPath.replace(/\\/g, "/").replace(/^\.\/?/, "").replace(/^\/+/, "");
  if (!cleaned || cleaned === ".") return nodeServerRelPath(serverId);
  return nodeServerRelPath(serverId, ...cleaned.split("/").filter(Boolean));
}

function isNodeAuthoritative(server: ServerFileStoreServer): boolean {
  if (isLocalNodeId(server.nodeId)) return false;
  return fs.existsSync(path.join(server.dataPath, NODE_AUTHORITATIVE_MARKER));
}

function resolveLocality(
  server: ServerFileStoreServer,
  mode: FileStoreLocalityMode,
): "local" | "remote" {
  if (mode === "local") return "local";
  if (mode === "remote") {
    if (isLocalNodeId(server.nodeId)) return "local";
    return "remote";
  }
  return isNodeAuthoritative(server) ? "remote" : "local";
}

function mapJail(err: unknown, relPath: string): never {
  if (err instanceof PathJailError) {
    throw new ServerFileStoreError("path_escape", err.message, { cause: err });
  }
  if (err instanceof ServerFileStoreError) throw err;
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("node_fs_local_unreachable") || message === "remote_only") {
    throw new ServerFileStoreError("node_unreachable", `node_unreachable: ${relPath}`, {
      cause: err,
    });
  }
  throw new ServerFileStoreError("io_failed", message || `io_failed: ${relPath}`, { cause: err });
}

function resolveLocalPath(server: ServerFileStoreServer, relPath: string): string {
  try {
    return resolveInJail(server.dataPath, relPath);
  } catch (err) {
    mapJail(err, relPath);
  }
}

function packSingleFileTarBase64(fileName: string, data: Buffer): string {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "playon-fs-put-"));
  try {
    const filePath = path.join(staging, fileName);
    fs.writeFileSync(filePath, data);
    const archive = path.join(staging, "one.tar");
    execFileSync("tar", ["-cf", archive, "-C", staging, fileName], { stdio: "pipe" });
    return fs.readFileSync(archive).toString("base64");
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export function openServerFileStore(
  server: ServerFileStoreServer,
  deps: ServerFileStoreDeps = {},
  opts?: { locality?: FileStoreLocalityMode },
): ServerFileStore {
  const mode = opts?.locality ?? "auto";
  const locality = resolveLocality(server, mode);
  const dispatch = deps.dispatch ?? dispatchNodeJob;
  const serverId = server.id;

  const onNode = <K extends NodeJobKind>(
    kind: K,
    args: NodeJobArgsInput<K>,
    timeoutMs: number,
  ): Promise<NodeJobResult<K>> => {
    if (!server.nodeId || isLocalNodeId(server.nodeId)) {
      throw new ServerFileStoreError("node_unreachable", "node_unreachable: no remote node");
    }
    return dispatch({
      nodeId: server.nodeId,
      kind,
      args,
      timeoutMs,
      localHandler: () => {
        throw new Error("node_fs_local_unreachable");
      },
    });
  };

  const readViaNodeArchive = async (
    relPath: string,
    opts?: { offset?: number; maxBytes?: number },
  ): Promise<ServerFileReadResult> => {
    const posix = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
    const base = path.posix.basename(posix);
    const parent = path.posix.dirname(posix);
    const parentRel = !parent || parent === "." ? "." : parent;
    const archived = await onNode(
      "fs_get_archive",
      { path: nodeJailRel(serverId, parentRel) },
      120_000,
    );
    if (!archived.archiveBase64) {
      throw new ServerFileStoreError("not_found", `not_found: ${relPath}`);
    }
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "playon-fs-read-"));
    try {
      const tarPath = path.join(staging, "tree.tar");
      const extractDir = path.join(staging, "tree");
      fs.mkdirSync(extractDir, { recursive: true });
      fs.writeFileSync(tarPath, Buffer.from(archived.archiveBase64, "base64"));
      execFileSync("tar", ["-xf", tarPath, "-C", extractDir], { stdio: "pipe" });
      const target = path.join(extractDir, base);
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        throw new ServerFileStoreError("not_found", `not_found: ${relPath}`);
      }
      const size = fs.statSync(target).size;
      const { offset, maxBytes } = readWindow(opts);
      if (offset > size) {
        return { path: relPath, content: "", bytesRead: 0, truncated: false, size };
      }
      const fd = fs.openSync(target, "r");
      try {
        const length = Math.min(maxBytes, size - offset);
        const buf = Buffer.alloc(length);
        const bytesRead = fs.readSync(fd, buf, 0, length, offset);
        return {
          path: relPath,
          content: buf.subarray(0, bytesRead).toString("utf8"),
          bytesRead,
          truncated: offset + bytesRead < size,
          size,
        };
      } finally {
        fs.closeSync(fd);
      }
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  };

  return {
    serverId,
    locality,

    async list(relPath = "."): Promise<ServerFileEntry[]> {
      if (locality === "remote") {
        try {
          const result = await onNode(
            "fs_list",
            { path: nodeJailRel(serverId, relPath) },
            60_000,
          );
          return result.entries;
        } catch (err) {
          mapJail(err, relPath);
        }
      }
      const target = resolveLocalPath(server, relPath);
      if (!fs.existsSync(target)) {
        throw new ServerFileStoreError("not_found", `not_found: ${relPath}`);
      }
      const stat = fs.statSync(target);
      if (!stat.isDirectory()) {
        throw new ServerFileStoreError("not_directory", `not_a_directory: ${relPath}`);
      }
      return fs.readdirSync(target).map((name) => {
        const child = path.join(target, name);
        return {
          name,
          type: fs.statSync(child).isDirectory() ? ("dir" as const) : ("file" as const),
        };
      });
    },

    async readText(relPath, opts): Promise<ServerFileReadResult> {
      const bounds = readWindow(opts);
      if (locality === "remote") {
        try {
          try {
            return await onNode(
              "fs_read_text",
              { path: nodeJailRel(serverId, relPath), ...bounds },
              60_000,
            );
          } catch (err) {
            if (!hasNodeJobErrorCode(err, "unsupported_job_kind")) throw err;
            return await readViaNodeArchive(relPath, opts);
          }
        } catch (err) {
          if (err instanceof ServerFileStoreError) throw err;
          mapJail(err, relPath);
        }
      }
      const target = resolveLocalPath(server, relPath);
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        throw new ServerFileStoreError("not_found", `not_found: ${relPath}`);
      }
      const size = fs.statSync(target).size;
      const { offset, maxBytes } = bounds;
      if (offset > size) {
        return { path: relPath, content: "", bytesRead: 0, truncated: false, size };
      }
      const fd = fs.openSync(target, "r");
      try {
        const length = Math.min(maxBytes, size - offset);
        const buf = Buffer.alloc(length);
        const bytesRead = fs.readSync(fd, buf, 0, length, offset);
        return {
          path: relPath,
          content: buf.subarray(0, bytesRead).toString("utf8"),
          bytesRead,
          truncated: offset + bytesRead < size,
          size,
        };
      } finally {
        fs.closeSync(fd);
      }
    },

    async readBytes(relPath) {
      if (locality === "remote") {
        try {
          const posix = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
          const base = path.posix.basename(posix);
          const parent = path.posix.dirname(posix);
          const parentRel = !parent || parent === "." ? "." : parent;
          const archived = await onNode(
            "fs_get_archive",
            { path: nodeJailRel(serverId, parentRel) },
            120_000,
          );
          if (!archived.archiveBase64) {
            throw new ServerFileStoreError("not_found", `not_found: ${relPath}`);
          }
          const staging = fs.mkdtempSync(path.join(os.tmpdir(), "playon-fs-rbytes-"));
          try {
            const tarPath = path.join(staging, "tree.tar");
            const extractDir = path.join(staging, "tree");
            fs.mkdirSync(extractDir, { recursive: true });
            fs.writeFileSync(tarPath, Buffer.from(archived.archiveBase64, "base64"));
            execFileSync("tar", ["-xf", tarPath, "-C", extractDir], { stdio: "pipe" });
            const target = path.join(extractDir, base);
            if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
              throw new ServerFileStoreError("not_found", `not_found: ${relPath}`);
            }
            const data = fs.readFileSync(target);
            return { path: relPath, data, size: data.byteLength };
          } finally {
            fs.rmSync(staging, { recursive: true, force: true });
          }
        } catch (err) {
          if (err instanceof ServerFileStoreError) throw err;
          mapJail(err, relPath);
        }
      }
      const target = resolveLocalPath(server, relPath);
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        throw new ServerFileStoreError("not_found", `not_found: ${relPath}`);
      }
      const data = fs.readFileSync(target);
      return { path: relPath, data, size: data.byteLength };
    },

    async writeText(relPath, content) {
      if (locality === "remote") {
        try {
          const result = await onNode(
            "fs_write_text",
            { path: nodeJailRel(serverId, relPath), content },
            60_000,
          );
          return { path: relPath, bytes: result.bytes };
        } catch (err) {
          mapJail(err, relPath);
        }
      }
      const target = resolveLocalPath(server, relPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, "utf8");
      return { path: relPath, bytes: Buffer.byteLength(content, "utf8") };
    },

    async writeBytes(relPath, data) {
      if (locality === "remote") {
        try {
          const posix = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
          const base = path.posix.basename(posix);
          const parent = path.posix.dirname(posix);
          const parentRel = !parent || parent === "." ? "." : parent;
          if (!base || base === "." || base === "..") {
            throw new ServerFileStoreError("io_failed", `invalid_path: ${relPath}`);
          }
          await onNode(
            "fs_ensure_dir",
            { path: nodeJailRel(serverId, parentRel) },
            60_000,
          );
          const archiveBase64 = packSingleFileTarBase64(base, data);
          await onNode(
            "fs_put_archive",
            {
              path: nodeJailRel(serverId, parentRel),
              archiveBase64,
              format: "tar",
            },
            300_000,
          );
          return { path: relPath, bytes: data.byteLength };
        } catch (err) {
          if (err instanceof ServerFileStoreError) throw err;
          mapJail(err, relPath);
        }
      }
      const target = resolveLocalPath(server, relPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      return { path: relPath, bytes: data.byteLength };
    },

    async delete(relPath) {
      if (locality === "remote") {
        try {
          await onNode("fs_remove", { path: nodeJailRel(serverId, relPath) }, 120_000);
          return { path: relPath, deleted: "dir" as const };
        } catch (err) {
          mapJail(err, relPath);
        }
      }
      const target = resolveLocalPath(server, relPath);
      if (!fs.existsSync(target)) {
        throw new ServerFileStoreError("not_found", `not_found: ${relPath}`);
      }
      const stat = fs.lstatSync(target);
      if (stat.isDirectory()) {
        fs.rmSync(target, { recursive: true, force: false });
        return { path: relPath, deleted: "dir" as const };
      }
      fs.unlinkSync(target);
      return { path: relPath, deleted: "file" as const };
    },

    async rename(fromPath, toPath, opts) {
      if (locality === "remote") {
        try {
          await onNode(
            "fs_rename",
            {
              from: nodeJailRel(serverId, fromPath),
              to: nodeJailRel(serverId, toPath),
              overwrite: Boolean(opts?.overwrite),
            },
            120_000,
          );
          return { from: fromPath, to: toPath };
        } catch (err) {
          mapJail(err, fromPath);
        }
      }
      const from = resolveLocalPath(server, fromPath);
      const to = resolveLocalPath(server, toPath);
      if (!fs.existsSync(from)) {
        throw new ServerFileStoreError("not_found", `not_found: ${fromPath}`);
      }
      if (fs.existsSync(to) && !opts?.overwrite) {
        throw new ServerFileStoreError("already_exists", `already_exists: ${toPath}`);
      }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (fs.existsSync(to) && opts?.overwrite) {
        fs.rmSync(to, { recursive: true, force: true });
      }
      fs.renameSync(from, to);
      return { from: fromPath, to: toPath };
    },

    async copy(fromPath, toPath, opts) {
      if (locality === "remote") {
        try {
          await onNode(
            "fs_copy",
            {
              from: nodeJailRel(serverId, fromPath),
              to: nodeJailRel(serverId, toPath),
              overwrite: Boolean(opts?.overwrite),
            },
            300_000,
          );
          return { from: fromPath, to: toPath };
        } catch (err) {
          mapJail(err, fromPath);
        }
      }
      const from = resolveLocalPath(server, fromPath);
      const to = resolveLocalPath(server, toPath);
      if (!fs.existsSync(from)) {
        throw new ServerFileStoreError("not_found", `not_found: ${fromPath}`);
      }
      if (fs.existsSync(to) && !opts?.overwrite) {
        throw new ServerFileStoreError("already_exists", `already_exists: ${toPath}`);
      }
      if (fs.existsSync(to) && opts?.overwrite) {
        fs.rmSync(to, { recursive: true, force: true });
      }
      copyRecursive(from, to);
      return { from: fromPath, to: toPath };
    },

    async ensureDir(relPath) {
      // Provisioning: a remote nodeId always gets the dir on the node, even before
      // the authoritative marker exists (create / prepareRemoteStart).
      const ensureRemote =
        locality === "remote" || (mode === "auto" && !isLocalNodeId(server.nodeId));
      if (ensureRemote && !isLocalNodeId(server.nodeId)) {
        try {
          const result = await onNode(
            "fs_ensure_dir",
            { path: nodeJailRel(serverId, relPath) },
            60_000,
          );
          return { path: relPath, ok: result.ok };
        } catch (err) {
          mapJail(err, relPath);
        }
      }
      const target = resolveLocalPath(server, relPath);
      fs.mkdirSync(target, { recursive: true });
      return { path: relPath, ok: true };
    },
  };
}

/** Map store failures onto HTTP envelope codes/statuses. */
export function serverFileStoreHttpStatus(err: unknown): 400 | 404 | 502 {
  if (err instanceof ServerFileStoreError) {
    if (err.code === "not_found" || err.code === "unknown_server") return 404;
    if (err.code === "node_unreachable") return 502;
    return 400;
  }
  const message = err instanceof Error ? err.message : "";
  if (message.startsWith("not_found") || message.startsWith("unknown_server")) return 404;
  return 400;
}

export function serverFileStoreErrorCode(err: unknown, fallback: string): string {
  if (err instanceof ServerFileStoreError) return err.code;
  const message = err instanceof Error ? err.message : "";
  if (message.startsWith("not_found")) return "not_found";
  if (message.startsWith("path escapes") || message.includes("path escapes jail")) {
    return "path_escape";
  }
  if (message.startsWith("not_a_directory")) return "not_directory";
  if (message.startsWith("already_exists")) return "already_exists";
  return fallback;
}
