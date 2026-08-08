import { describe, expect, it } from "vitest";
import {
  CreateWatcherSchema,
  SkillWatcherTemplateSchema,
  WatcherActionSchema,
  WatcherTriggerSchema,
  computeNextDueAt,
  cronMatches,
  isWatcherScriptTool,
  validateLogPattern,
} from "./watcher.js";
import { SkillMetadataSchema } from "./skill.js";
import { WsEventSchema } from "./events.js";

describe("Watcher schemas", () => {
  it("accepts schedule + tools action", () => {
    const trigger = WatcherTriggerSchema.parse({
      kind: "schedule",
      intervalMs: 60_000,
    });
    const action = WatcherActionSchema.parse({
      kind: "tools",
      steps: [{ tool: "servers_health_check", args: { remediate: true } }],
    });
    expect(trigger.kind).toBe("schedule");
    expect(action.kind).toBe("tools");
    const created = CreateWatcherSchema.parse({
      serverId: "s1",
      name: "Health",
      trigger,
      action,
    });
    expect(created.cooldownMs).toBe(60_000);
  });

  it("accepts log_pattern and agent action", () => {
    const trigger = WatcherTriggerSchema.parse({
      kind: "log_pattern",
      pattern: "Error|Exception",
      flags: "i",
    });
    expect(validateLogPattern(trigger.pattern, trigger.flags).ok).toBe(true);
    const action = WatcherActionSchema.parse({
      kind: "agent",
      prompt: "Investigate the error in recent logs.",
    });
    expect(action.includeContext).toBe(true);
  });

  it("rejects unknown script tools", () => {
    expect(() =>
      WatcherActionSchema.parse({
        kind: "tools",
        steps: [{ tool: "servers_delete", args: {} }],
      }),
    ).toThrow();
    expect(isWatcherScriptTool("servers_restart")).toBe(true);
    expect(isWatcherScriptTool("servers_delete")).toBe(false);
  });

  it("skill metadata accepts watcher templates", () => {
    const tpl = SkillWatcherTemplateSchema.parse({
      name: "Health restart",
      defaultEnabled: false,
      trigger: { kind: "health", onFail: ["restart"] },
      action: {
        kind: "tools",
        steps: [{ tool: "servers_restart", args: {} }],
      },
    });
    const skill = SkillMetadataSchema.parse({
      name: "fixtures.lab-docker-server",
      version: "0.1.0",
      watchers: [tpl],
    });
    expect(skill.watchers).toHaveLength(1);
  });

  it("computes next due and matches cron", () => {
    const from = Date.UTC(2026, 0, 1, 12, 0, 0);
    const due = computeNextDueAt({ intervalMs: 30_000 }, from);
    expect(due).toBe(from + 30_000);
    expect(cronMatches("* * * * *", new Date())).toBe(true);
    expect(cronMatches("0 0 1 1 0", new Date("2026-06-15T12:00:00Z"))).toBe(false);
  });

  it("accepts watcher and panel.input WS events", () => {
    expect(
      WsEventSchema.parse({
        type: "watcher.run",
        watcherId: "w1",
        serverId: "s1",
        runId: "r1",
        status: "ok",
      }).type,
    ).toBe("watcher.run");
    expect(
      WsEventSchema.parse({
        type: "panel.input",
        serverId: "s1",
        inputType: "vote",
        payload: { choice: "a" },
      }).type,
    ).toBe("panel.input");
  });
});
