import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { parseA2sInfo } from "@playon/server-query";
import { createDb } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import type { AppConfig } from "../config.js";
import { resolveFixturesRoot } from "../lab-games-root.js";
import { ServerQueryService } from "./server-query.js";
import { ServerService } from "./servers.js";

const temps: Array<{ root: string; sqlite: Database.Database }> = [];

function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function tempConfig(): { db: ReturnType<typeof createDb>["db"]; config: AppConfig } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-query-svc-"));
  const dbPath = path.join(root, "playon.sqlite");
  applyBootstrap(dbPath);
  const { db, sqlite } = createDb(dbPath);
  temps.push({ root, sqlite });
  const repoRoot = findRepoRoot(process.cwd());
  const config: AppConfig = {
    port: 0,
    dataRoot: root,
    dbPath,
    sessionSecret: "query-test-secret",
    llmMode: "openai_compatible",
    runtimeMode: "docker",
    skillsRoots: [
      resolveFixturesRoot(repoRoot),
      path.join(repoRoot, "skills", "fixtures"),
      path.join(root, "skills"),
    ],
    advertiseHost: "127.0.0.1",
  };
  return { db, config };
}

afterEach(() => {
  while (temps.length) {
    const entry = temps.pop();
    if (!entry) break;
    try {
      entry.sqlite.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(entry.root, { recursive: true, force: true });
  }
});

describe("ServerQueryService", () => {
  it("queryTest runs fixtures.query-skill-module connector", async () => {
    const { db, config } = tempConfig();
    const servers = new ServerService(db, config);
    const queries = new ServerQueryService(servers, config);
    const state = await queries.queryTest({
      host: "127.0.0.1",
      port: 19090,
      skillName: "fixtures.query-skill-module",
    });
    expect(state.online).toBe(true);
    expect(state.map).toBe("testmap");
    expect(state.maxPlayers).toBe(4);
  });

  it("queryTest parses a fake PZ Steam A2S reply via project_zomboid dialect", async () => {
    const { db, config } = tempConfig();
    const servers = new ServerService(db, config);
    const queries = new ServerQueryService(servers, config);
    // Same captured A2S_INFO hex as packages/server-query project-zomboid tests.
    const reply = Buffer.from(
      "ffffffff49115468697320697320686f7720796f752064696564004d756c6472617567682c204b59007a6f6d626f69640050726f6a656374205a6f6d626f6964000000405000646c0001312e302e302e3000b1853f1438207224c740013b6d6f646465643b7076703b56455253494f4e3a34322e32300038a8010000000000",
      "hex",
    );
    expect(parseA2sInfo(reply).players).toBe(64);
    const socket = dgram.createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.on("message", (_msg, rinfo) => {
        socket.send(reply, rinfo.port, rinfo.address);
      });
      socket.bind(0, "127.0.0.1", () => resolve());
    });
    const port = socket.address().port;
    try {
      const state = await queries.queryTest({
        host: "127.0.0.1",
        port,
        gamePort: port,
        queryDialect: "project_zomboid",
        timeoutMs: 1000,
      });
      expect(state.online).toBe(true);
      expect(state.players).toBe(64);
      expect(state.maxPlayers).toBe(80);
      expect(state.name).toBe("This is how you died");
    } finally {
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    }
  });
});
