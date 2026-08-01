import fs from "node:fs";
import path from "node:path";
import { resolveInJail } from "@playon/runtime";
import type { ServerService } from "./servers.js";

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

  async read(serverId: string, relPath: string): Promise<{ path: string; content: string }> {
    const root = await this.jailRoot(serverId);
    const target = resolveInJail(root, relPath);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      throw new Error(`not_found: ${relPath}`);
    }
    const content = fs.readFileSync(target, "utf8");
    if (content.length > 512_000) {
      throw new Error("file_too_large");
    }
    return { path: relPath, content };
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
}
