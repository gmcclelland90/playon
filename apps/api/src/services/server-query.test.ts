import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import type { AppConfig } from "../config.js";
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
      path.join(repoRoot, "skills", "games"),
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

  it("panelFields omits offline errors", async () => {
    const { db, config } = tempConfig();
    const servers = new ServerService(db, config);
    const queries = new ServerQueryService(servers, config);
    expect(queries.panelFields({ online: false, error: "nope" })).toEqual({});
    expect(queries.panelFields({ online: true, players: 1, maxPlayers: 8, map: "x" })).toEqual({
      online: true,
      players: 1,
      maxPlayers: 8,
      map: "x",
    });
  });
});
