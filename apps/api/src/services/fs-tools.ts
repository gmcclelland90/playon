import fs from "node:fs";
import path from "node:path";
import { resolveInJail } from "@playon/runtime";
import type { ServerService } from "./servers.js";

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

export class ServerFsService {
  constructor(private readonly servers: ServerService) {}

  private async jailRoot(serverId: string): Promise<string> {
    const server = await this.servers.get(serverId);
    if (!server) throw new Error(`unknown_server: ${serverId}`);
    return server.dataPath;
  }

  async list(serverId: string, relPath = "."): Promise<Array<{ name: string; type: "file" | "dir" }>> {
    const root = await this.jailRoot(serverId);
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
    const root = await this.jailRoot(serverId);
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
    const root = await this.jailRoot(serverId);
    const target = resolveInJail(root, relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
    return { path: relPath, bytes: Buffer.byteLength(content, "utf8") };
  }

  async delete(serverId: string, relPath: string): Promise<{ path: string; deleted: "file" | "dir" }> {
    const root = await this.jailRoot(serverId);
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
    const root = await this.jailRoot(serverId);
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
    const root = await this.jailRoot(serverId);
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
