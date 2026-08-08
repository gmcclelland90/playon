/**
 * Compatibility facade over `ServerFileStore`.
 * New call sites should use `servers.files(serverId)` instead.
 */
import type { ServerService } from "./servers.js";
import {
  openServerFileStore,
  ServerFileStoreError,
  type ServerFileReadResult,
  type ServerFileStore,
} from "./server-file-store.js";

export { nodeJailRel } from "./server-file-store.js";
export {
  openServerFileStore,
  ServerFileStoreError,
  serverFileStoreErrorCode,
  serverFileStoreHttpStatus,
  type FileStoreLocalityMode,
  type ServerFileStore,
  type ServerFileStoreErrorCode,
} from "./server-file-store.js";

/** @deprecated Prefer `servers.files(serverId)`. */
export class ServerFsService {
  constructor(private readonly servers: ServerService) {}

  private async store(serverId: string): Promise<ServerFileStore> {
    if (typeof this.servers.files === "function") {
      return this.servers.files(serverId);
    }
    const server = await this.servers.get(serverId);
    if (!server) {
      throw new ServerFileStoreError("unknown_server", `unknown_server: ${serverId}`);
    }
    return openServerFileStore(server);
  }

  async list(
    serverId: string,
    relPath = ".",
  ): Promise<Array<{ name: string; type: "file" | "dir" }>> {
    return (await this.store(serverId)).list(relPath);
  }

  async read(
    serverId: string,
    relPath: string,
    opts?: { offset?: number; maxBytes?: number },
  ): Promise<ServerFileReadResult> {
    return (await this.store(serverId)).readText(relPath, opts);
  }

  async write(
    serverId: string,
    relPath: string,
    content: string,
  ): Promise<{ path: string; bytes: number }> {
    return (await this.store(serverId)).writeText(relPath, content);
  }

  async delete(serverId: string, relPath: string): Promise<{ path: string; deleted: "file" | "dir" }> {
    return (await this.store(serverId)).delete(relPath);
  }

  async rename(
    serverId: string,
    fromPath: string,
    toPath: string,
    opts?: { overwrite?: boolean },
  ): Promise<{ from: string; to: string }> {
    return (await this.store(serverId)).rename(fromPath, toPath, opts);
  }

  async copy(
    serverId: string,
    fromPath: string,
    toPath: string,
    opts?: { overwrite?: boolean },
  ): Promise<{ from: string; to: string }> {
    return (await this.store(serverId)).copy(fromPath, toPath, opts);
  }
}
