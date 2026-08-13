import { z } from "zod";

/** Tools allowed in deterministic watcher scripts (v1). */
export const WATCHER_SCRIPT_TOOLS = [
  "servers_health_check",
  "servers_start",
  "servers_stop",
  "servers_restart",
  "servers_logs_tail",
  "servers_query",
  "snapshot_create",
  "panel_publish",
  "rcon_exec",
  "rcon_say",
  "net_port_check",
  "fs_read",
  "fs_list",
] as const;

export type WatcherScriptTool = (typeof WATCHER_SCRIPT_TOOLS)[number];

export const WatcherScriptToolSchema = z.enum(WATCHER_SCRIPT_TOOLS);

export const ServerStatusForWatcherSchema = z.enum([
  "creating",
  "starting",
  "running",
  "stopping",
  "stopped",
  "error",
]);

export const WatcherScheduleTriggerSchema = z.object({
  kind: z.literal("schedule"),
  /** Minimum gap between fires; also the cadence when cron is omitted. Floor 10s. */
  intervalMs: z.number().int().min(10_000).max(86_400_000),
  /** Optional 5-field cron (min hour dom month dow). Still respects intervalMs floor. */
  cron: z.string().min(1).max(64).optional(),
});

export const WatcherServerStatusTriggerSchema = z.object({
  kind: z.literal("server_status"),
  statuses: z.array(ServerStatusForWatcherSchema).min(1),
});

export const WatcherLogPatternTriggerSchema = z.object({
  kind: z.literal("log_pattern"),
  pattern: z.string().min(1).max(512),
  flags: z
    .string()
    .regex(/^[gimsuy]*$/)
    .max(8)
    .optional(),
});

export const WatcherHealthTriggerSchema = z.object({
  kind: z.literal("health"),
  checkIds: z.array(z.string().min(1)).optional(),
  onFail: z.array(z.enum(["none", "restart", "escalate"])).optional(),
});

export const WatcherQueryTriggerSchema = z.object({
  kind: z.literal("query"),
  predicate: z.enum(["players_eq", "players_gte", "players_lte", "map_eq"]),
  value: z.union([z.number(), z.string()]),
});

export const WatcherPanelInputTriggerSchema = z.object({
  kind: z.literal("panel_input"),
  inputType: z.enum(["vote", "readiness"]),
});

export const WatcherWorkshopUpdateTriggerSchema = z.object({
  kind: z.literal("workshop_update"),
  /** Steam Workshop / publishedfile IDs to monitor. */
  workshopIds: z.array(z.string().min(1)).min(1),
});

export const WatcherTriggerSchema = z.discriminatedUnion("kind", [
  WatcherScheduleTriggerSchema,
  WatcherServerStatusTriggerSchema,
  WatcherLogPatternTriggerSchema,
  WatcherHealthTriggerSchema,
  WatcherQueryTriggerSchema,
  WatcherPanelInputTriggerSchema,
  WatcherWorkshopUpdateTriggerSchema,
]);

export type WatcherTrigger = z.infer<typeof WatcherTriggerSchema>;

export const WatcherToolStepSchema = z.object({
  tool: WatcherScriptToolSchema,
  args: z.record(z.unknown()).default({}),
});

export const WatcherToolsActionSchema = z.object({
  kind: z.literal("tools"),
  steps: z.array(WatcherToolStepSchema).min(1).max(20),
  continueOnError: z.boolean().default(false),
});

export const WatcherAgentActionSchema = z.object({
  kind: z.literal("agent"),
  prompt: z.string().min(1).max(8000),
  includeContext: z.boolean().default(true),
});

export const WatcherActionSchema = z.discriminatedUnion("kind", [
  WatcherToolsActionSchema,
  WatcherAgentActionSchema,
]);

export type WatcherAction = z.infer<typeof WatcherActionSchema>;

export const WatcherSourceSchema = z.enum(["user", "skill_template"]);
export const WatcherConfirmModeSchema = z.enum(["auto"]);
export const WatcherRunStatusSchema = z.enum([
  "queued",
  "running",
  "ok",
  "error",
  "skipped",
]);

export const WatcherSchema = z.object({
  id: z.string().min(1),
  serverId: z.string().min(1),
  name: z.string().min(1).max(128),
  enabled: z.boolean(),
  trigger: WatcherTriggerSchema,
  action: WatcherActionSchema,
  cooldownMs: z.number().int().min(0).max(86_400_000).default(60_000),
  debounceMs: z.number().int().min(0).max(600_000).default(0),
  confirmMode: WatcherConfirmModeSchema.default("auto"),
  source: WatcherSourceSchema.default("user"),
  skillSlug: z.string().min(1).optional(),
  lastFiredAt: z.number().int().nonnegative().nullable().optional(),
  nextDueAt: z.number().int().nonnegative().nullable().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export type Watcher = z.infer<typeof WatcherSchema>;

export const WatcherRunSchema = z.object({
  id: z.string().min(1),
  watcherId: z.string().min(1),
  serverId: z.string().min(1),
  status: WatcherRunStatusSchema,
  triggerPayload: z.record(z.unknown()).default({}),
  result: z.record(z.unknown()).nullable().optional(),
  error: z.string().nullable().optional(),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().nullable().optional(),
});

export type WatcherRun = z.infer<typeof WatcherRunSchema>;

/** Skill-declared watcher template (seeded on server create). */
export const SkillWatcherTemplateSchema = z.object({
  name: z.string().min(1).max(128),
  trigger: WatcherTriggerSchema,
  action: WatcherActionSchema,
  cooldownMs: z.number().int().min(0).max(86_400_000).default(60_000),
  debounceMs: z.number().int().min(0).max(600_000).default(0),
  defaultEnabled: z.boolean().default(false),
});

export type SkillWatcherTemplate = z.infer<typeof SkillWatcherTemplateSchema>;

/** Facts used to decide whether skill templates may seed `action.kind=agent`. */
export type WatcherSeedTargetFacts = {
  managedFrom?: string | null;
  nodeAuthoritative?: boolean | null;
  hasNodeAuthoritativeMarker?: boolean | null;
};

export function isManagedOrNodeAuthoritativeSeedTarget(
  facts: WatcherSeedTargetFacts,
): boolean {
  return Boolean(
    (typeof facts.managedFrom === "string" && facts.managedFrom.length > 0) ||
      facts.nodeAuthoritative === true ||
      facts.hasNodeAuthoritativeMarker === true,
  );
}

const MANAGED_WATCHER_NOTIFY_MESSAGE =
  "A watcher fired on this managed server. Schedule a reboot when convenient — PlayOn will not auto-restart.";

const WORKSHOP_WATCHER_NOTIFY_MESSAGE =
  "One or more workshop mods have been updated. Schedule a server restart to apply changes — PlayOn will not auto-restart.";

/** Deterministic tools + notify action used when agent templates cannot be seeded. */
export function skillWatcherNotifyAction(
  templateName: string,
  trigger?: WatcherTrigger,
): Extract<WatcherAction, { kind: "tools" }> {
  const message =
    trigger?.kind === "workshop_update"
      ? WORKSHOP_WATCHER_NOTIFY_MESSAGE
      : MANAGED_WATCHER_NOTIFY_MESSAGE;
  return {
    kind: "tools",
    continueOnError: false,
    steps: [
      {
        tool: "panel_publish",
        args: {
          title: templateName,
          message,
        },
      },
    ],
  };
}

/**
 * Skill templates may declare `action.kind=agent` for lab / unmanaged servers.
 * Managed and node-authoritative hosts get tools + notify only — never an
 * auto-approved agent turn that can restart or mutate a live world.
 */
export function sanitizeSkillWatcherTemplatesForSeed(
  templates: SkillWatcherTemplate[],
  facts: WatcherSeedTargetFacts,
): SkillWatcherTemplate[] {
  if (!isManagedOrNodeAuthoritativeSeedTarget(facts)) return templates;
  return templates.map((template) => {
    if (template.action.kind !== "agent") return template;
    return {
      ...template,
      action: skillWatcherNotifyAction(template.name, template.trigger),
    };
  });
}

export const CreateWatcherSchema = z.object({
  serverId: z.string().min(1),
  name: z.string().min(1).max(128),
  enabled: z.boolean().default(true),
  trigger: WatcherTriggerSchema,
  action: WatcherActionSchema,
  cooldownMs: z.number().int().min(0).max(86_400_000).default(60_000),
  debounceMs: z.number().int().min(0).max(600_000).default(0),
});

export type CreateWatcherInput = z.input<typeof CreateWatcherSchema>;

export const UpdateWatcherSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  enabled: z.boolean().optional(),
  trigger: WatcherTriggerSchema.optional(),
  action: WatcherActionSchema.optional(),
  cooldownMs: z.number().int().min(0).max(86_400_000).optional(),
  debounceMs: z.number().int().min(0).max(600_000).optional(),
});

export type UpdateWatcherInput = z.input<typeof UpdateWatcherSchema>;

/** Validate log regex at create time; rejects invalid / catastrophic patterns. */
export function validateLogPattern(
  pattern: string,
  flags?: string,
): { ok: true; regex: RegExp } | { ok: false; error: string } {
  try {
    const re = new RegExp(pattern, flags ?? "");
    // Cheap smoke: empty string match should finish quickly
    re.test("");
    return { ok: true, regex: re };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "invalid_log_pattern",
    };
  }
}

export function isWatcherScriptTool(name: string): name is WatcherScriptTool {
  return (WATCHER_SCRIPT_TOOLS as readonly string[]).includes(name);
}

/**
 * Minimal 5-field cron matcher (min hour dom month dow).
 * Fields: star, number, comma-list, range, or step (star-slash-n).
 */
export function cronMatches(cron: string, date: Date = new Date()): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, month, dow] = parts;
  const vals = [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    date.getDay(),
  ];
  const fields = [min, hour, dom, month, dow];
  for (let i = 0; i < 5; i++) {
    if (!cronFieldMatches(fields[i]!, vals[i]!)) return false;
  }
  return true;
}

function cronFieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;
  for (const part of field.split(",")) {
    if (part.includes("/")) {
      const [base, stepStr] = part.split("/");
      const step = Number(stepStr);
      if (!Number.isFinite(step) || step <= 0) continue;
      if (base === "*" || base === "0") {
        if (value % step === 0) return true;
      }
      continue;
    }
    if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      if (Number.isFinite(a) && Number.isFinite(b) && value >= a! && value <= b!) {
        return true;
      }
      continue;
    }
    if (Number(part) === value) return true;
  }
  return false;
}

/** Next due timestamp for a schedule trigger from `fromMs`. */
export function computeNextDueAt(
  trigger: { intervalMs: number; cron?: string },
  fromMs: number = Date.now(),
): number {
  const floor = Math.max(10_000, trigger.intervalMs);
  if (!trigger.cron) return fromMs + floor;

  // Walk minute-by-minute up to 8 days for next cron match, then apply floor vs last fire.
  const start = new Date(fromMs);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const limit = fromMs + 8 * 86_400_000;
  for (let t = start.getTime(); t <= limit; t += 60_000) {
    if (cronMatches(trigger.cron, new Date(t))) {
      return Math.max(t, fromMs + floor);
    }
  }
  return fromMs + floor;
}
