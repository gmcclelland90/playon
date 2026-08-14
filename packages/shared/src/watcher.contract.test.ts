import { describe, expect, it } from "vitest";
import {
  CreateWatcherSchema,
  PLATFORM_HEALTH_MONITOR_TEMPLATE,
  SkillWatcherTemplateSchema,
  WatcherActionSchema,
  WatcherTriggerSchema,
  computeNextDueAt,
  cronMatches,
  isManagedOrNodeAuthoritativeSeedTarget,
  isWatcherScriptTool,
  sanitizeSkillWatcherTemplatesForSeed,
  sanitizeWatcherActionForTrigger,
  skillWatcherNotifyAction,
  validateLogPattern,
  watcherActionWouldRestart,
  watcherTriggerIsHealthRestart,
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

  it("accepts workshop_update trigger", () => {
    const trigger = WatcherTriggerSchema.parse({
      kind: "workshop_update",
      workshopIds: ["2169330869", "2260789317"],
    });
    expect(trigger.kind).toBe("workshop_update");
    if (trigger.kind === "workshop_update") {
      expect(trigger.workshopIds).toHaveLength(2);
    }
    const action = WatcherActionSchema.parse({
      kind: "tools",
      steps: [{ tool: "panel_publish", args: { message: "Workshop mod updated" } }],
    });
    const watcher = CreateWatcherSchema.parse({
      serverId: "s1",
      name: "Workshop update notifier",
      trigger,
      action,
    });
    expect(watcher.trigger.kind).toBe("workshop_update");
  });

  it("rejects workshop_update trigger with empty workshopIds", () => {
    expect(() =>
      WatcherTriggerSchema.parse({
        kind: "workshop_update",
        workshopIds: [],
      }),
    ).toThrow();
  });

  it("classifies managed and node-authoritative seed targets", () => {
    expect(isManagedOrNodeAuthoritativeSeedTarget({})).toBe(false);
    expect(isManagedOrNodeAuthoritativeSeedTarget({ managedFrom: "" })).toBe(false);
    expect(isManagedOrNodeAuthoritativeSeedTarget({ nodeAuthoritative: false })).toBe(
      false,
    );
    expect(
      isManagedOrNodeAuthoritativeSeedTarget({ managedFrom: "/opt/pzserver" }),
    ).toBe(true);
    expect(isManagedOrNodeAuthoritativeSeedTarget({ nodeAuthoritative: true })).toBe(
      true,
    );
    expect(
      isManagedOrNodeAuthoritativeSeedTarget({ hasNodeAuthoritativeMarker: true }),
    ).toBe(true);
  });

  it("keeps agent templates on unmanaged seed targets", () => {
    const agent = SkillWatcherTemplateSchema.parse({
      name: "Escalate to monitor agent",
      trigger: { kind: "health", onFail: ["escalate"] },
      action: {
        kind: "agent",
        prompt: "Diagnose the health failure.",
      },
    });
    const seeded = sanitizeSkillWatcherTemplatesForSeed([agent], {});
    expect(seeded[0]?.action.kind).toBe("agent");
  });

  it("rewrites agent templates to tools + notify on managed / node-authoritative seed", () => {
    const agent = SkillWatcherTemplateSchema.parse({
      name: "Escalate to monitor agent",
      trigger: { kind: "health", onFail: ["escalate"] },
      action: {
        kind: "agent",
        prompt: "Diagnose and restart if safe.",
      },
    });
    for (const facts of [
      { managedFrom: "/opt/pzserver" },
      { nodeAuthoritative: true },
      { hasNodeAuthoritativeMarker: true },
    ]) {
      const seeded = sanitizeSkillWatcherTemplatesForSeed([agent], facts);
      expect(seeded).toHaveLength(1);
      expect(seeded[0]?.action.kind).toBe("tools");
      expect(seeded[0]?.action).toEqual(
        skillWatcherNotifyAction(agent.name, agent.trigger),
      );
      if (seeded[0]?.action.kind === "tools") {
        expect(seeded[0].action.steps.some((s) => s.tool === "servers_restart")).toBe(
          false,
        );
        expect(seeded[0].action.steps.every((s) => s.tool === "panel_publish")).toBe(
          true,
        );
      }
    }
  });

  it("preserves NZL-style workshop notify templates on managed seed", () => {
    const notify = SkillWatcherTemplateSchema.parse({
      name: "Workshop Update Notifier",
      defaultEnabled: true,
      cooldownMs: 300_000,
      debounceMs: 60_000,
      trigger: { kind: "workshop_update", workshopIds: ["3579640010"] },
      action: {
        kind: "tools",
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
    });
    const seeded = sanitizeSkillWatcherTemplatesForSeed([notify], {
      managedFrom: "/opt/pzserver",
      nodeAuthoritative: true,
    });
    expect(seeded[0]?.action).toEqual(notify.action);
    expect(seeded[0]?.action.kind).toBe("tools");
    if (seeded[0]?.action.kind === "tools") {
      expect(seeded[0].action.steps[0]?.tool).toBe("panel_publish");
      expect(seeded[0].action.steps.some((s) => s.tool === "servers_restart")).toBe(
        false,
      );
    }
    expect(watcherActionWouldRestart(seeded[0]!.action)).toBe(false);
  });

  it("rewrites workshop_update start/restart/remediate to notify-only on any host", () => {
    const restarting = SkillWatcherTemplateSchema.parse({
      name: "Workshop Update Notifier",
      defaultEnabled: true,
      trigger: { kind: "workshop_update", workshopIds: ["3579640010"] },
      action: {
        kind: "tools",
        steps: [{ tool: "servers_restart", args: {} }],
      },
    });
    for (const facts of [{}, { managedFrom: "/opt/pzserver" }]) {
      const seeded = sanitizeSkillWatcherTemplatesForSeed([restarting], facts);
      expect(watcherActionWouldRestart(seeded[0]!.action)).toBe(false);
      expect(seeded[0]?.action).toEqual(
        skillWatcherNotifyAction(restarting.name, restarting.trigger),
      );
    }
    expect(
      watcherActionWouldRestart(
        sanitizeWatcherActionForTrigger(
          restarting.trigger,
          restarting.action,
          restarting.name,
        ),
      ),
    ).toBe(false);
  });

  it("platform health monitor is tools restart, not an agent turn", () => {
    expect(watcherTriggerIsHealthRestart(PLATFORM_HEALTH_MONITOR_TEMPLATE.trigger)).toBe(
      true,
    );
    expect(PLATFORM_HEALTH_MONITOR_TEMPLATE.defaultEnabled).toBe(true);
    expect(PLATFORM_HEALTH_MONITOR_TEMPLATE.action.kind).toBe("tools");
    expect(watcherActionWouldRestart(PLATFORM_HEALTH_MONITOR_TEMPLATE.action)).toBe(true);
    const seeded = sanitizeSkillWatcherTemplatesForSeed(
      [PLATFORM_HEALTH_MONITOR_TEMPLATE],
      { managedFrom: "/opt/pzserver", nodeAuthoritative: true },
    );
    expect(seeded[0]?.action.kind).toBe("tools");
    expect(watcherActionWouldRestart(seeded[0]!.action)).toBe(true);
  });
});
