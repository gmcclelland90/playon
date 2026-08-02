import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import type { AppConfig } from "../config.js";
import { HealthService } from "./health.js";
import { NetToolsService } from "./net-tools.js";
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-health-"));
  const dbPath = path.join(root, "playon.sqlite");
  applyBootstrap(dbPath);
  const { db, sqlite } = createDb(dbPath);
  temps.push({ root, sqlite });
  const repoRoot = findRepoRoot(process.cwd());
  const config: AppConfig = {
    port: 0,
    dataRoot: root,
    dbPath,
    sessionSecret: "health-test-secret",
    llmMode: "openai_compatible",
    runtimeMode: "docker",
    skillsRoots: [
      path.join(repoRoot, "skills", "games"),
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

describe("HealthService", () => {
  it("reports process failure and remediates with restart", async () => {
    const { db, config } = tempConfig();
    const servers = new ServerService(db, config);
    const net = new NetToolsService(servers);
    const health = new HealthService(servers, net, config);

    const created = await servers.createFromSkill({
      skillName: "games.minecraft-paper",
      serverName: "Health Paper",
    });
    expect(created.status).toBe("stopped");

    const report = await health.checkServer(created.id, { remediate: true });
    expect(report.checks.some((c) => c.id === "process" && !c.ok)).toBe(true);
    expect(report.checks.some((c) => c.remediated === "restart")).toBe(true);
    const after = await servers.get(created.id);
    expect(after?.status).toBe("running");
  });
});
