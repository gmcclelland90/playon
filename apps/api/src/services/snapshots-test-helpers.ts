import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { NODE_AUTHORITATIVE_MARKER } from "@playon/shared";
import { createDb, type Db } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { nodes, servers } from "../db/schema.js";
import type { AppConfig } from "../config.js";
import { ServerService } from "./servers.js";
import { SnapshotService } from "./snapshots.js";

const temps: Array<{ root: string; sqlite: Database.Database }> = [];

export function tempEnv(): {
  db: Db;
  config: AppConfig;
  servers: ServerService;
  snapshots: SnapshotService;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-snap-"));
  const dbPath = path.join(root, "playon.db");
  applyBootstrap(dbPath);
  const config: AppConfig = {
    port: 0,
    dataRoot: root,
    dbPath,
    sessionSecret: "test",
    llmMode: "openai_compatible",
    runtimeMode: "docker",
    advertiseHost: "127.0.0.1",
    skillsRoots: [path.join(root, "skills")],
  };
  const { db, sqlite } = createDb(dbPath);
  temps.push({ root, sqlite });
  const serverService = new ServerService(db, config);
  const snapshotService = new SnapshotService(db, config, serverService);
  return { db, config, servers: serverService, snapshots: snapshotService };
}

export async function insertServer(
  db: Db,
  config: AppConfig,
  id: string,
  contents: Record<string, string>,
  opts?: { nodeId?: string; nodeAuthoritative?: boolean },
): Promise<string> {
  const dataPath = path.join(config.dataRoot, "servers", id);
  fs.mkdirSync(dataPath, { recursive: true });
  for (const [name, body] of Object.entries(contents)) {
    fs.writeFileSync(path.join(dataPath, name), body);
  }
  if (opts?.nodeAuthoritative) {
    fs.writeFileSync(path.join(dataPath, NODE_AUTHORITATIVE_MARKER), `${opts.nodeId ?? "node-z"}\n`);
  }
  if (opts?.nodeId) {
    await db.insert(nodes).values({
      id: opts.nodeId,
      name: "lab-node",
      os: "linux",
      docker: true,
      native: true,
      steamcmd: false,
      lastSeenAt: new Date(),
      kind: "lan",
    });
  }
  await db.insert(servers).values({
    id,
    name: `Server ${id}`,
    game: "test",
    nodeId: opts?.nodeId ?? null,
    runtimeMode: "docker",
    status: "stopped",
    dataPath,
    createdAt: new Date(),
  });
  return dataPath;
}

export function cleanupSnapshotTemps() {
  for (const entry of temps.splice(0)) {
    entry.sqlite.close();
    fs.rmSync(entry.root, { recursive: true, force: true });
  }
}
