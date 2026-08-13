import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NODE_AUTHORITATIVE_MARKER, type SkillWatcherTemplate } from "@playon/shared";
import { applyBootstrap } from "../db/migrate.js";
import { createDb } from "../db/client.js";
import { WatcherService } from "./watchers.js";

const agentTemplate: SkillWatcherTemplate = {
  name: "Escalate to monitor agent",
  defaultEnabled: false,
  cooldownMs: 300_000,
  debounceMs: 0,
  trigger: { kind: "health", onFail: ["escalate"] },
  action: {
    kind: "agent",
    includeContext: true,
    prompt: "Diagnose using servers_health_check and remediate if safe (restart).",
  },
};

const workshopNotifyTemplate: SkillWatcherTemplate = {
  name: "Workshop Update Notifier",
  defaultEnabled: true,
  cooldownMs: 300_000,
  debounceMs: 60_000,
  trigger: { kind: "workshop_update", workshopIds: ["3579640010"] },
  action: {
    kind: "tools",
    continueOnError: false,
    steps: [
      {
        tool: "panel_publish",
        args: {
          title: "Workshop Mod Updated",
          message:
            "ST Additions - Pry Open has been updated. Please schedule a server restart to apply changes.",
        },
      },
    ],
  },
};

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

  it("seeds agent templates on unmanaged servers", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-watchers-"));
    dirs.push(root);
    const dbPath = path.join(root, "playon.db");
    applyBootstrap(dbPath);
    const { db } = createDb(dbPath);
    const { servers } = await import("../db/schema.js");
    const dataPath = path.join(root, "servers", "lab");
    fs.mkdirSync(dataPath, { recursive: true });
    await db.insert(servers).values({
      id: "lab1",
      name: "Lab",
      game: "lab",
      nodeId: null,
      runtimeMode: "docker",
      status: "stopped",
      dataPath,
      createdAt: new Date(),
    });

    const svc = new WatcherService(db);
    const seeded = await svc.seedFromSkill("lab1", "fixtures.lab-docker-server", [
      agentTemplate,
    ]);
    expect(seeded).toHaveLength(1);
    expect(seeded[0]?.action.kind).toBe("agent");
    expect(seeded[0]?.source).toBe("skill_template");
  });

  it("does not seed action.kind=agent on managed or node-authoritative servers", async () => {
    const cases: Array<{
      id: string;
      mark: (dataPath: string) => void;
    }> = [
      {
        id: "managed1",
        mark: (dataPath) => {
          fs.writeFileSync(
            path.join(dataPath, "skill.json"),
            JSON.stringify({ managedFrom: "/opt/pzserver" }),
          );
        },
      },
      {
        id: "nodeauth1",
        mark: (dataPath) => {
          fs.writeFileSync(path.join(dataPath, NODE_AUTHORITATIVE_MARKER), "node-z\n");
        },
      },
      {
        id: "both1",
        mark: (dataPath) => {
          fs.writeFileSync(
            path.join(dataPath, "skill.json"),
            JSON.stringify({
              managedFrom: "/opt/pzserver",
              nodeAuthoritative: true,
            }),
          );
          fs.writeFileSync(path.join(dataPath, NODE_AUTHORITATIVE_MARKER), "node-z\n");
        },
      },
    ];

    for (const c of cases) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-watchers-"));
      dirs.push(root);
      const dbPath = path.join(root, "playon.db");
      applyBootstrap(dbPath);
      const { db } = createDb(dbPath);
      const { servers } = await import("../db/schema.js");
      const dataPath = path.join(root, "servers", c.id);
      fs.mkdirSync(dataPath, { recursive: true });
      c.mark(dataPath);
      await db.insert(servers).values({
        id: c.id,
        name: "Managed",
        game: "zomboid",
        nodeId: "node-z",
        runtimeMode: "native",
        status: "stopped",
        dataPath,
        createdAt: new Date(),
      });

      const svc = new WatcherService(db);
      const seeded = await svc.seedFromSkill(c.id, "games.project-zomboid", [
        agentTemplate,
        workshopNotifyTemplate,
      ]);
      expect(seeded, c.id).toHaveLength(2);
      expect(
        seeded.every((w) => w.action.kind !== "agent"),
        `${c.id} must not seed action.kind=agent`,
      ).toBe(true);

      const rewritten = seeded.find((w) => w.name === agentTemplate.name);
      expect(rewritten?.action.kind).toBe("tools");
      if (rewritten?.action.kind === "tools") {
        expect(rewritten.action.steps.every((s) => s.tool === "panel_publish")).toBe(
          true,
        );
        expect(rewritten.action.steps.some((s) => s.tool === "servers_restart")).toBe(
          false,
        );
      }

      const notify = seeded.find((w) => w.name === workshopNotifyTemplate.name);
      expect(notify?.action).toEqual(workshopNotifyTemplate.action);
      expect(notify?.action.kind).toBe("tools");
    }
  });
});
