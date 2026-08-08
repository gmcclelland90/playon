import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyBootstrap } from "../db/migrate.js";
import { createDb } from "../db/client.js";
import { WatcherService } from "./watchers.js";

describe("WatcherService", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    dirs.length = 0;
  });

  it("creates schedule watcher and lists due", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-watchers-"));
    dirs.push(root);
    const dbPath = path.join(root, "playon.db");
    applyBootstrap(dbPath);
    const { db } = createDb(dbPath);
    const { servers } = await import("../db/schema.js");
    await db.insert(servers).values({
      id: "srv1",
      name: "Lab",
      game: "lab",
      nodeId: null,
      runtimeMode: "docker",
      status: "running",
      dataPath: path.join(root, "servers", "srv1"),
      createdAt: new Date(),
    });

    const svc = new WatcherService(db);
    const w = await svc.create({
      serverId: "srv1",
      name: "Health",
      enabled: true,
      trigger: { kind: "schedule", intervalMs: 10_000 },
      action: {
        kind: "tools",
        steps: [{ tool: "servers_health_check", args: {} }],
      },
      cooldownMs: 10_000,
      debounceMs: 0,
    });
    expect(w.id).toBeTruthy();
    expect(w.nextDueAt).toBeTruthy();

    // Force due
    await svc.markFired(w.id, Date.now() - 60_000);
    const due = await svc.listDueSchedule(Date.now());
    expect(due.some((x) => x.id === w.id)).toBe(true);

    const run = await svc.createRun({
      watcherId: w.id,
      serverId: "srv1",
      status: "running",
      triggerPayload: { kind: "schedule" },
    });
    await svc.finishRun(run.id, { status: "ok", result: { steps: [] } });
    const runs = await svc.listRuns(w.id);
    expect(runs[0]?.status).toBe("ok");
  });

  it("rejects invalid log pattern", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-watchers-"));
    dirs.push(root);
    const dbPath = path.join(root, "playon.db");
    applyBootstrap(dbPath);
    const { db } = createDb(dbPath);
    const { servers } = await import("../db/schema.js");
    await db.insert(servers).values({
      id: "srv2",
      name: "Lab",
      game: "lab",
      nodeId: null,
      runtimeMode: "docker",
      status: "running",
      dataPath: path.join(root, "servers", "srv2"),
      createdAt: new Date(),
    });
    const svc = new WatcherService(db);
    await expect(
      svc.create({
        serverId: "srv2",
        name: "Bad",
        enabled: true,
        trigger: { kind: "log_pattern", pattern: "(" },
        action: {
          kind: "tools",
          steps: [{ tool: "servers_logs_tail", args: {} }],
        },
      }),
    ).rejects.toThrow(/invalid_log_pattern/);
  });
});
