import fs from "node:fs";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  CreateWatcherSchema,
  NODE_AUTHORITATIVE_MARKER,
  UpdateWatcherSchema,
  WatcherActionSchema,
  WatcherTriggerSchema,
  computeNextDueAt,
  sanitizeSkillWatcherTemplatesForSeed,
  validateLogPattern,
  type CreateWatcherInput,
  type SkillWatcherTemplate,
  type UpdateWatcherInput,
  type Watcher,
  type WatcherAction,
  type WatcherRun,
  type WatcherRunStatusSchema,
  type WatcherSeedTargetFacts,
  type WatcherTrigger,
} from "@playon/shared";
import type { z } from "zod";
import type { Db } from "../db/client.js";
import { servers, watcherRuns, watchers } from "../db/schema.js";
import { readSkillMarker } from "./skill-marker.js";

type RunStatus = z.infer<typeof WatcherRunStatusSchema>;

function parseTrigger(json: string): WatcherTrigger {
  return WatcherTriggerSchema.parse(JSON.parse(json));
}

function parseAction(json: string): WatcherAction {
  return WatcherActionSchema.parse(JSON.parse(json));
}

function toWatcher(row: typeof watchers.$inferSelect): Watcher {
  return {
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    enabled: row.enabled,
    trigger: parseTrigger(row.triggerJson),
    action: parseAction(row.actionJson),
    cooldownMs: row.cooldownMs,
    debounceMs: row.debounceMs,
    confirmMode: row.confirmMode === "auto" ? "auto" : "auto",
    source: row.source === "skill_template" ? "skill_template" : "user",
    skillSlug: row.skillSlug ?? undefined,
    lastFiredAt: row.lastFiredAt ? row.lastFiredAt.getTime() : null,
    nextDueAt: row.nextDueAt ? row.nextDueAt.getTime() : null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function toRun(row: typeof watcherRuns.$inferSelect): WatcherRun {
  return {
    id: row.id,
    watcherId: row.watcherId,
    serverId: row.serverId,
    status: row.status as RunStatus,
    triggerPayload: JSON.parse(row.triggerPayloadJson) as Record<string, unknown>,
    result: row.resultJson
      ? (JSON.parse(row.resultJson) as Record<string, unknown>)
      : null,
    error: row.error,
    startedAt: row.startedAt.getTime(),
    finishedAt: row.finishedAt ? row.finishedAt.getTime() : null,
  };
}

function validateTrigger(trigger: WatcherTrigger): void {
  if (trigger.kind === "log_pattern") {
    const check = validateLogPattern(trigger.pattern, trigger.flags);
    if (!check.ok) throw new Error(`invalid_log_pattern: ${check.error}`);
  }
  if (trigger.kind === "schedule" && trigger.cron) {
    const parts = trigger.cron.trim().split(/\s+/);
    if (parts.length !== 5) throw new Error("invalid_cron: expected_5_fields");
  }
}

export class WatcherService {
  constructor(private readonly db: Db) {}

  async list(serverId?: string): Promise<Watcher[]> {
    const rows = serverId
      ? await this.db.select().from(watchers).where(eq(watchers.serverId, serverId))
      : await this.db.select().from(watchers);
    return rows.map(toWatcher);
  }

  async listEnabled(): Promise<Watcher[]> {
    const rows = await this.db.select().from(watchers).where(eq(watchers.enabled, true));
    return rows.map(toWatcher);
  }

  async get(id: string): Promise<Watcher | null> {
    const rows = await this.db.select().from(watchers).where(eq(watchers.id, id)).limit(1);
    return rows[0] ? toWatcher(rows[0]) : null;
  }

  async create(
    input: CreateWatcherInput,
    opts?: { source?: "user" | "skill_template"; skillSlug?: string },
  ): Promise<Watcher> {
    const body = CreateWatcherSchema.parse(input);
    validateTrigger(body.trigger);
    const id = nanoid();
    const now = new Date();
    const nextDueAt =
      body.trigger.kind === "schedule"
        ? new Date(computeNextDueAt(body.trigger, now.getTime()))
        : null;
    await this.db.insert(watchers).values({
      id,
      serverId: body.serverId,
      name: body.name,
      enabled: body.enabled,
      triggerJson: JSON.stringify(body.trigger),
      actionJson: JSON.stringify(body.action),
      cooldownMs: body.cooldownMs,
      debounceMs: body.debounceMs,
      confirmMode: "auto",
      source: opts?.source ?? "user",
      skillSlug: opts?.skillSlug ?? null,
      lastFiredAt: null,
      nextDueAt,
      createdAt: now,
      updatedAt: now,
    });
    return (await this.get(id))!;
  }

  async update(id: string, input: UpdateWatcherInput): Promise<Watcher | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const body = UpdateWatcherSchema.parse(input);
    if (body.trigger) validateTrigger(body.trigger);
    const trigger = body.trigger ?? existing.trigger;
    const now = new Date();
    const nextDueAt =
      trigger.kind === "schedule"
        ? new Date(
            computeNextDueAt(
              trigger,
              existing.lastFiredAt ?? now.getTime(),
            ),
          )
        : null;
    await this.db
      .update(watchers)
      .set({
        name: body.name ?? existing.name,
        enabled: body.enabled ?? existing.enabled,
        triggerJson: JSON.stringify(trigger),
        actionJson: JSON.stringify(body.action ?? existing.action),
        cooldownMs: body.cooldownMs ?? existing.cooldownMs,
        debounceMs: body.debounceMs ?? existing.debounceMs,
        nextDueAt,
        updatedAt: now,
      })
      .where(eq(watchers.id, id));
    return this.get(id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<Watcher | null> {
    return this.update(id, { enabled });
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;
    await this.db.delete(watcherRuns).where(eq(watcherRuns.watcherId, id));
    await this.db.delete(watchers).where(eq(watchers.id, id));
    return true;
  }

  async markFired(id: string, atMs: number = Date.now()): Promise<void> {
    const w = await this.get(id);
    if (!w) return;
    const nextDueAt =
      w.trigger.kind === "schedule"
        ? new Date(computeNextDueAt(w.trigger, atMs))
        : null;
    await this.db
      .update(watchers)
      .set({
        lastFiredAt: new Date(atMs),
        nextDueAt,
        updatedAt: new Date(atMs),
      })
      .where(eq(watchers.id, id));
  }

  async createRun(args: {
    watcherId: string;
    serverId: string;
    status: RunStatus;
    triggerPayload?: Record<string, unknown>;
  }): Promise<WatcherRun> {
    const id = nanoid();
    const now = new Date();
    await this.db.insert(watcherRuns).values({
      id,
      watcherId: args.watcherId,
      serverId: args.serverId,
      status: args.status,
      triggerPayloadJson: JSON.stringify(args.triggerPayload ?? {}),
      resultJson: null,
      error: null,
      startedAt: now,
      finishedAt: null,
    });
    return (await this.getRun(id))!;
  }

  async finishRun(
    id: string,
    args: {
      status: RunStatus;
      result?: Record<string, unknown>;
      error?: string;
    },
  ): Promise<WatcherRun | null> {
    await this.db
      .update(watcherRuns)
      .set({
        status: args.status,
        resultJson: args.result ? JSON.stringify(args.result) : null,
        error: args.error ?? null,
        finishedAt: new Date(),
      })
      .where(eq(watcherRuns.id, id));
    return this.getRun(id);
  }

  async getRun(id: string): Promise<WatcherRun | null> {
    const rows = await this.db
      .select()
      .from(watcherRuns)
      .where(eq(watcherRuns.id, id))
      .limit(1);
    return rows[0] ? toRun(rows[0]) : null;
  }

  async listRuns(watcherId: string, limit = 50): Promise<WatcherRun[]> {
    const rows = await this.db
      .select()
      .from(watcherRuns)
      .where(eq(watcherRuns.watcherId, watcherId))
      .orderBy(desc(watcherRuns.startedAt))
      .limit(limit);
    return rows.map(toRun);
  }

  async listDueSchedule(nowMs: number = Date.now()): Promise<Watcher[]> {
    const enabled = await this.listEnabled();
    return enabled.filter((w) => {
      if (w.trigger.kind !== "schedule") return false;
      if (w.nextDueAt == null) return true;
      return w.nextDueAt <= nowMs;
    });
  }

  /**
   * Seed skill watcher templates for a server. Replaces prior skill_template
   * rows for the same skill slug on that server.
   *
   * Managed / node-authoritative servers never receive `action.kind=agent`
   * (rewritten to tools + notify). Import/manage callers should use this same
   * path so the guard cannot be skipped.
   */
  async seedFromSkill(
    serverId: string,
    skillSlug: string,
    templates: SkillWatcherTemplate[],
  ): Promise<Watcher[]> {
    const existing = await this.db
      .select()
      .from(watchers)
      .where(
        and(eq(watchers.serverId, serverId), eq(watchers.source, "skill_template")),
      );
    for (const row of existing) {
      if (row.skillSlug === skillSlug || !row.skillSlug) {
        await this.delete(row.id);
      }
    }
    const safeTemplates = sanitizeSkillWatcherTemplatesForSeed(
      templates,
      await this.seedTargetFacts(serverId),
    );
    const created: Watcher[] = [];
    for (const t of safeTemplates) {
      created.push(
        await this.create(
          {
            serverId,
            name: t.name,
            enabled: t.defaultEnabled,
            trigger: t.trigger,
            action: t.action,
            cooldownMs: t.cooldownMs,
            debounceMs: t.debounceMs,
          },
          { source: "skill_template", skillSlug },
        ),
      );
    }
    return created;
  }

  private async seedTargetFacts(serverId: string): Promise<WatcherSeedTargetFacts> {
    const rows = await this.db
      .select()
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    const dataPath = rows[0]?.dataPath;
    if (!dataPath) return {};
    const marker = readSkillMarker(dataPath);
    return {
      managedFrom: marker?.managedFrom,
      nodeAuthoritative: marker?.nodeAuthoritative,
      hasNodeAuthoritativeMarker: fs.existsSync(
        path.join(dataPath, NODE_AUTHORITATIVE_MARKER),
      ),
    };
  }
}
