import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveInJail } from "@playon/runtime";
import { isLocalNodeId, NODE_AUTHORITATIVE_MARKER } from "@playon/shared";
import { dispatchNodeJob, nodeServerRelPath } from "./node-runtime.js";
import type { ServerRecord, ServerService } from "./servers.js";

const DEFAULT_READ_MAX_BYTES = 512_000;

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

export class ServerFsService {
  constructor(private readonly servers: ServerService) {}

  private async resolveServer(serverId: string): Promise<ServerRecord> {
    const server = await this.servers.get(serverId);
    if (!server) throw new Error(`unknown_server: ${serverId}`);
    return server;
  }

  /** Live files on a remote node (manage cutover); Home jail is a stub. */
  private routesToNode(server: ServerRecord): boolean {
    if (isLocalNodeId(server.nodeId)) return false;
    return fs.existsSync(path.join(server.dataPath, NODE_AUTHORITATIVE_MARKER));
  }

  async list(serverId: string, relPath = "."): Promise<Array<{ name: string; type: "file" | "dir" }>> {
    const server = await this.resolveServer(serverId);
    if (this.routesToNode(server)) {
      const result = await dispatchNodeJob<{
        path: string;
        entries: Array<{ name: string; type: "file" | "dir" }>;
      }>({
        nodeId: server.nodeId,
        kind: "fs_list",
        args: { path: nodeJailRel(serverId, relPath) },
        timeoutMs: 60_000,
        localHandler: async () => {
          throw new Error("node_fs_local_unreachable");
        },
      });
      return result.entries;
    }

    const root = server.dataPath;
    const target = resolveInJail(root, relPath);
    if (!fs.existsSync(target)) throw new Error(`not_found: ${relPath}`);
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) throw new Error(`not_a_directory: ${relPath}`);

    return fs.readdirSync(target).map((name) => {
      const child = path.join(target, name);
      return {
        name,
        type: fs.statSync(child).isDirectory() ? ("dir" as const) : ("file" as const),
      };
    });
  }

  /** Older node-agents lack fs_read_text — pull the parent dir archive and read one file. */
  private async readViaNodeArchive(
    server: ServerRecord,
    serverId: string,
    relPath: string,
    opts?: { offset?: number; maxBytes?: number },
  ): Promise<{
    path: string;
    content: string;
    bytesRead: number;
    truncated: boolean;
    size: number;
  }> {
    const posix = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
    const base = path.posix.basename(posix);
    const parent = path.posix.dirname(posix);
    const parentRel = !parent || parent === "." ? "." : parent;
    const archived = await dispatchNodeJob<{ archiveBase64: string }>({
      nodeId: server.nodeId,
      kind: "fs_get_archive",
      args: { path: nodeJailRel(serverId, parentRel) },
      timeoutMs: 120_000,
      localHandler: async () => {
        throw new Error("node_fs_local_unreachable");
      },
    });
    if (!archived.archiveBase64) throw new Error(`not_found: ${relPath}`);
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "playon-fs-read-"));
    try {
      const tarPath = path.join(staging, "tree.tar");
      const extractDir = path.join(staging, "tree");
      fs.mkdirSync(extractDir, { recursive: true });
      fs.writeFileSync(tarPath, Buffer.from(archived.archiveBase64, "base64"));
      execFileSync("tar", ["-xf", tarPath, "-C", extractDir], { stdio: "pipe" });
      const target = path.join(extractDir, base);
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        throw new Error(`not_found: ${relPath}`);
      }
      const size = fs.statSync(target).size;
      const offset = Math.max(0, Math.floor(opts?.offset ?? 0));
      const maxBytes = Math.min(
        DEFAULT_READ_MAX_BYTES,
        Math.max(1, Math.floor(opts?.maxBytes ?? DEFAULT_READ_MAX_BYTES)),
      );
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
  }

  async read(
    serverId: string,
    relPath: string,
    opts?: { offset?: number; maxBytes?: number },
  ): Promise<{
    path: string;
    content: string;
    bytesRead: number;
    truncated: boolean;
    size: number;
  }> {
    const server = await this.resolveServer(serverId);
    if (this.routesToNode(server)) {
      try {
        return await dispatchNodeJob({
          nodeId: server.nodeId,
          kind: "fs_read_text",
          args: {
            path: nodeJailRel(serverId, relPath),
            offset: opts?.offset,
            maxBytes: opts?.maxBytes,
          },
          timeoutMs: 60_000,
          localHandler: async () => {
            throw new Error("node_fs_local_unreachable");
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("unsupported_job_kind")) throw err;
        return this.readViaNodeArchive(server, serverId, relPath, opts);
      }
    }

    const root = server.dataPath;
    const target = resolveInJail(root, relPath);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      throw new Error(`not_found: ${relPath}`);
    }
    const size = fs.statSync(target).size;
    const offset = Math.max(0, Math.floor(opts?.offset ?? 0));
    const maxBytes = Math.min(
      DEFAULT_READ_MAX_BYTES,
      Math.max(1, Math.floor(opts?.maxBytes ?? DEFAULT_READ_MAX_BYTES)),
    );
    if (offset > size) {
      return { path: relPath, content: "", bytesRead: 0, truncated: false, size };
    }
    const fd = fs.openSync(target, "r");
    try {
      const length = Math.min(maxBytes, size - offset);
      const buf = Buffer.alloc(length);
      const bytesRead = fs.readSync(fd, buf, 0, length, offset);
      const content = buf.subarray(0, bytesRead).toString("utf8");
      const truncated = offset + bytesRead < size;
      return { path: relPath, content, bytesRead, truncated, size };
    } finally {
      fs.closeSync(fd);
    }
  }

  async write(
    serverId: string,
    relPath: string,
    content: string,
  ): Promise<{ path: string; bytes: number }> {
    const server = await this.resolveServer(serverId);
    if (this.routesToNode(server)) {
      const result = await dispatchNodeJob<{ path: string; bytes: number }>({
        nodeId: server.nodeId,
        kind: "fs_write_text",
        args: {
          path: nodeJailRel(serverId, relPath),
          content,
        },
        timeoutMs: 60_000,
        localHandler: async () => {
          throw new Error("node_fs_local_unreachable");
        },
      });
      return { path: relPath, bytes: result.bytes };
    }

    const root = server.dataPath;
    const target = resolveInJail(root, relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
    return { path: relPath, bytes: Buffer.byteLength(content, "utf8") };
  }

  async delete(serverId: string, relPath: string): Promise<{ path: string; deleted: "file" | "dir" }> {
    const server = await this.resolveServer(serverId);
    if (this.routesToNode(server)) {
      await dispatchNodeJob({
        nodeId: server.nodeId,
        kind: "fs_remove",
        args: { path: nodeJailRel(serverId, relPath) },
        timeoutMs: 120_000,
        localHandler: async () => {
          throw new Error("node_fs_local_unreachable");
        },
      });
      // Node fs_remove is recursive; callers rarely branch on file vs dir.
      return { path: relPath, deleted: "dir" };
    }

    const root = server.dataPath;
    const target = resolveInJail(root, relPath);
    if (!fs.existsSync(target)) throw new Error(`not_found: ${relPath}`);
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) {
      fs.rmSync(target, { recursive: true, force: false });
      return { path: relPath, deleted: "dir" };
    }
    fs.unlinkSync(target);
    return { path: relPath, deleted: "file" };
  }

  async rename(
    serverId: string,
    fromPath: string,
    toPath: string,
    opts?: { overwrite?: boolean },
  ): Promise<{ from: string; to: string }> {
    const server = await this.resolveServer(serverId);
    if (this.routesToNode(server)) {
      return dispatchNodeJob({
        nodeId: server.nodeId,
        kind: "fs_rename",
        args: {
          from: nodeJailRel(serverId, fromPath),
          to: nodeJailRel(serverId, toPath),
          overwrite: Boolean(opts?.overwrite),
        },
        timeoutMs: 120_000,
        localHandler: async () => {
          throw new Error("node_fs_local_unreachable");
        },
      });
    }

    const root = server.dataPath;
    const from = resolveInJail(root, fromPath);
    const to = resolveInJail(root, toPath);
    if (!fs.existsSync(from)) throw new Error(`not_found: ${fromPath}`);
    if (fs.existsSync(to) && !opts?.overwrite) {
      throw new Error(`already_exists: ${toPath}`);
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.existsSync(to) && opts?.overwrite) {
      fs.rmSync(to, { recursive: true, force: true });
    }
    fs.renameSync(from, to);
    return { from: fromPath, to: toPath };
  }

  async copy(
    serverId: string,
    fromPath: string,
    toPath: string,
    opts?: { overwrite?: boolean },
  ): Promise<{ from: string; to: string }> {
    const server = await this.resolveServer(serverId);
    if (this.routesToNode(server)) {
      return dispatchNodeJob({
        nodeId: server.nodeId,
        kind: "fs_copy",
        args: {
          from: nodeJailRel(serverId, fromPath),
          to: nodeJailRel(serverId, toPath),
          overwrite: Boolean(opts?.overwrite),
        },
        timeoutMs: 300_000,
        localHandler: async () => {
          throw new Error("node_fs_local_unreachable");
        },
      });
    }

    const root = server.dataPath;
    const from = resolveInJail(root, fromPath);
    const to = resolveInJail(root, toPath);
    if (!fs.existsSync(from)) throw new Error(`not_found: ${fromPath}`);
    if (fs.existsSync(to) && !opts?.overwrite) {
      throw new Error(`already_exists: ${toPath}`);
    }
    if (fs.existsSync(to) && opts?.overwrite) {
      fs.rmSync(to, { recursive: true, force: true });
    }
    copyRecursive(from, to);
    return { from: fromPath, to: toPath };
  }
}
