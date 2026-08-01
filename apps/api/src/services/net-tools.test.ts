import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import { createDb, type Db } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { NetToolsService } from "./net-tools.js";
import { ServerService } from "./servers.js";

const temps: Array<{ root: string; sqlite: Database.Database; server?: http.Server }> = [];

function findRepoRoot(): string {
  let dir = path.resolve(process.cwd());
  while (true) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

function tempEnv(): { db: Db; config: AppConfig; net: NetToolsService; servers: ServerService } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-net-"));
  const dbPath = path.join(root, "playon.db");
  applyBootstrap(dbPath);
  const config: AppConfig = {
    port: 0,
    dataRoot: root,
    dbPath,
    sessionSecret: "test",
    llmMode: "mock",
    runtimeMode: "mock",
    advertiseHost: "127.0.0.1",
    skillsRoots: [path.join(findRepoRoot(), "skills", "fixtures"), path.join(root, "skills")],
  };
  const { db, sqlite } = createDb(dbPath);
  temps.push({ root, sqlite });
  const servers = new ServerService(db, config);
  return { db, config, servers, net: new NetToolsService(servers) };
}

afterEach(async () => {
  for (const entry of temps.splice(0)) {
    if (entry.server) {
      await new Promise<void>((resolve) => entry.server!.close(() => resolve()));
    }
    entry.sqlite.close();
    fs.rmSync(entry.root, { recursive: true, force: true });
  }
});

describe("NetToolsService", () => {
  it("suggests a bindable port", async () => {
    const { net } = tempEnv();
    const suggestion = await net.suggestBind({ preferredPort: 29000 });
    expect(suggestion.available).toBe(true);
    expect(suggestion.port).toBeGreaterThanOrEqual(29000);
  });

  it("fetches a URL into the server jail", async () => {
    const { net, servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: "fixtures.fake-http-game" });

    const httpServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("payload-from-fetch");
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    const addr = httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("no_port");
    temps[temps.length - 1]!.server = httpServer;

    const fetched = await net.fetchUrl({
      serverId: server.id,
      url: `http://127.0.0.1:${addr.port}/file.txt`,
      destPath: "game/downloaded.txt",
    });
    expect(fetched.bytes).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(server.dataPath, "game", "downloaded.txt"), "utf8")).toBe(
      "payload-from-fetch",
    );
  });
});
