import { eq } from "drizzle-orm";
import { surfaceXp, type AgentPersona } from "@playon/agent-core";
import type { Db } from "../db/client.js";
import { agentProgress } from "../db/schema.js";

export type AgentProgressRecord = {
  persona: AgentPersona | string;
  xp: number;
  level: number;
  title: string;
  updatedAt: Date;
};

export type XpAward = {
  persona: string;
  xpGained: number;
  reason: string;
  leveledUp: boolean;
  previousLevel: number;
  progress: AgentProgressRecord;
  celebrate: boolean;
};

export function levelFromXp(xp: number): number {
  let level = 1;
  let need = 100;
  let remaining = Math.max(0, xp);
  while (remaining >= need && level < 99) {
    remaining -= need;
    level += 1;
    need = Math.floor(need * 1.35);
  }
  return level;
}

export function titleFor(persona: string, level: number): string {
  const band =
    level >= 12
      ? "Legend"
      : level >= 8
        ? "Veteran"
        : level >= 5
          ? "Operator"
          : level >= 3
            ? "Apprentice"
            : "Rookie";
  const label = persona.replace(/_/g, " ");
  return `${band} ${label}`;
}

function isFailedResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const rec = result as Record<string, unknown>;
  if (rec.error) return true;
  if (rec.ok === false) return true;
  return false;
}

/** Default cast shown on the host before anyone has earned XP. */
export const DEFAULT_SERVER_CAST = [
  "installer",
  "monitor",
  "configurer",
  "troubleshooter",
  "backup",
  "player_panel",
  "modder",
  "orchestrator",
] as const;

export class AgentProgressService {
  constructor(private readonly db: Db) {}

  async list(): Promise<AgentProgressRecord[]> {
    const rows = await this.db.select().from(agentProgress);
    return rows
      .map((r) => ({
        persona: r.persona,
        xp: r.xp,
        level: r.level,
        title: r.title,
        updatedAt: r.updatedAt,
      }))
      .sort((a, b) => b.xp - a.xp || a.persona.localeCompare(b.persona));
  }

  /** Full roster: defaults at Rookie + any earned progress rows. */
  async listCast(): Promise<AgentProgressRecord[]> {
    const earned = await this.list();
    const byPersona = new Map(earned.map((row) => [row.persona, row]));
    const cast: AgentProgressRecord[] = DEFAULT_SERVER_CAST.map((persona) => {
      const existing = byPersona.get(persona);
      if (existing) return existing;
      return {
        persona,
        xp: 0,
        level: 1,
        title: titleFor(persona, 1),
        updatedAt: new Date(0),
      };
    });
    for (const row of earned) {
      if (!DEFAULT_SERVER_CAST.includes(row.persona as (typeof DEFAULT_SERVER_CAST)[number])) {
        cast.push(row);
      }
    }
    return cast.sort((a, b) => b.xp - a.xp || a.persona.localeCompare(b.persona));
  }

  async get(persona: string): Promise<AgentProgressRecord> {
    const rows = await this.db
      .select()
      .from(agentProgress)
      .where(eq(agentProgress.persona, persona))
      .limit(1);
    if (rows[0]) {
      return {
        persona: rows[0].persona,
        xp: rows[0].xp,
        level: rows[0].level,
        title: rows[0].title,
        updatedAt: rows[0].updatedAt,
      };
    }
    return {
      persona,
      xp: 0,
      level: 1,
      title: titleFor(persona, 1),
      updatedAt: new Date(0),
    };
  }

  async award(persona: string, xpGained: number, reason: string): Promise<XpAward> {
    const current = await this.get(persona);
    const previousLevel = current.level;
    const xp = current.xp + Math.max(0, xpGained);
    const level = levelFromXp(xp);
    const title = titleFor(persona, level);
    const now = new Date();
    const existing = await this.db
      .select()
      .from(agentProgress)
      .where(eq(agentProgress.persona, persona))
      .limit(1);
    if (existing[0]) {
      await this.db
        .update(agentProgress)
        .set({ xp, level, title, updatedAt: now })
        .where(eq(agentProgress.persona, persona));
    } else {
      await this.db.insert(agentProgress).values({
        persona,
        xp,
        level,
        title,
        updatedAt: now,
      });
    }
    const leveledUp = level > previousLevel;
    return {
      persona,
      xpGained,
      reason,
      leveledUp,
      previousLevel,
      progress: { persona, xp, level, title, updatedAt: now },
      celebrate: leveledUp,
    };
  }

  async awardForTools(
    persona: string,
    toolTrace: Array<{ name: string; result?: unknown }>,
  ): Promise<XpAward[]> {
    const awards: XpAward[] = [];
    for (const trace of toolTrace) {
      if (isFailedResult(trace.result)) continue;
      const spec = surfaceXp(trace.name);
      const award = await this.award(persona, spec.xp, spec.reason);
      award.celebrate = Boolean(spec.celebrate) || award.leveledUp;
      awards.push(award);
    }
    return awards;
  }
}
