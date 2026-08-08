import { eq } from "drizzle-orm";
import {
  AGENT_SKILLS,
  skillLabel,
  surfaceSkill,
  surfaceXp,
  type AgentSkill,
  type ToolSurface,
} from "@playon/agent-core";
import type { Db } from "../db/client.js";
import { agentProgress } from "../db/schema.js";

export type AgentProgressRecord = {
  skill: AgentSkill | string;
  xp: number;
  level: number;
  title: string;
  updatedAt: Date;
};

export type XpAward = {
  skill: string;
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

/** XP progress within the current level (for skill bars). */
export function xpProgressInLevel(xp: number): {
  level: number;
  intoLevel: number;
  need: number;
} {
  let level = 1;
  let need = 100;
  let remaining = Math.max(0, xp);
  while (remaining >= need && level < 99) {
    remaining -= need;
    level += 1;
    need = Math.floor(need * 1.35);
  }
  return { level, intoLevel: remaining, need };
}

export function titleFor(skill: string, level: number): string {
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
  return `${band} ${skillLabel(skill)}`;
}

function isFailedResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const rec = result as Record<string, unknown>;
  if (rec.error) return true;
  if (rec.ok === false) return true;
  return false;
}

/** Default skill roster shown before anyone has earned XP. */
export const DEFAULT_AGENT_SKILLS = AGENT_SKILLS;

export class AgentProgressService {
  constructor(private readonly db: Db) {}

  async list(): Promise<AgentProgressRecord[]> {
    const rows = await this.db.select().from(agentProgress);
    return rows
      .map((r) => ({
        skill: r.skill,
        xp: r.xp,
        level: r.level,
        title: r.title,
        updatedAt: r.updatedAt,
      }))
      .sort((a, b) => b.xp - a.xp || a.skill.localeCompare(b.skill));
  }

  /** Full roster: defaults at Rookie + any earned progress rows. */
  async listSkills(): Promise<AgentProgressRecord[]> {
    const earned = await this.list();
    const bySkill = new Map(earned.map((row) => [row.skill, row]));
    const skills: AgentProgressRecord[] = DEFAULT_AGENT_SKILLS.map((skill) => {
      const existing = bySkill.get(skill);
      if (existing) return existing;
      return {
        skill,
        xp: 0,
        level: 1,
        title: titleFor(skill, 1),
        updatedAt: new Date(0),
      };
    });
    for (const row of earned) {
      if (!DEFAULT_AGENT_SKILLS.includes(row.skill as (typeof DEFAULT_AGENT_SKILLS)[number])) {
        skills.push(row);
      }
    }
    // Keep roster order (DEFAULT_AGENT_SKILLS), extras after sorted by XP.
    const extras = skills.slice(DEFAULT_AGENT_SKILLS.length).sort(
      (a, b) => b.xp - a.xp || a.skill.localeCompare(b.skill),
    );
    return [...skills.slice(0, DEFAULT_AGENT_SKILLS.length), ...extras];
  }

  async get(skill: string): Promise<AgentProgressRecord> {
    const rows = await this.db
      .select()
      .from(agentProgress)
      .where(eq(agentProgress.skill, skill))
      .limit(1);
    if (rows[0]) {
      return {
        skill: rows[0].skill,
        xp: rows[0].xp,
        level: rows[0].level,
        title: rows[0].title,
        updatedAt: rows[0].updatedAt,
      };
    }
    return {
      skill,
      xp: 0,
      level: 1,
      title: titleFor(skill, 1),
      updatedAt: new Date(0),
    };
  }

  async award(skill: string, xpGained: number, reason: string): Promise<XpAward> {
    const current = await this.get(skill);
    const previousLevel = current.level;
    const xp = current.xp + Math.max(0, xpGained);
    const level = levelFromXp(xp);
    const title = titleFor(skill, level);
    const now = new Date();
    const existing = await this.db
      .select()
      .from(agentProgress)
      .where(eq(agentProgress.skill, skill))
      .limit(1);
    if (existing[0]) {
      await this.db
        .update(agentProgress)
        .set({ xp, level, title, updatedAt: now })
        .where(eq(agentProgress.skill, skill));
    } else {
      await this.db.insert(agentProgress).values({
        skill,
        xp,
        level,
        title,
        updatedAt: now,
      });
    }
    const leveledUp = level > previousLevel;
    return {
      skill,
      xpGained,
      reason,
      leveledUp,
      previousLevel,
      progress: { skill, xp, level, title, updatedAt: now },
      celebrate: leveledUp,
    };
  }

  /** Pass the turn's composed surface; the ambient fallback covers unmigrated tools only. */
  async awardForTools(
    toolTrace: Array<{ name: string; result?: unknown }>,
    surface?: ToolSurface,
  ): Promise<XpAward[]> {
    const awards: XpAward[] = [];
    for (const trace of toolTrace) {
      if (isFailedResult(trace.result)) continue;
      const skill = surface ? surface.skill(trace.name) : surfaceSkill(trace.name);
      const spec = surface ? surface.xp(trace.name) : surfaceXp(trace.name);
      const award = await this.award(skill, spec.xp, spec.reason);
      award.celebrate = Boolean(spec.celebrate) || award.leveledUp;
      awards.push(award);
    }
    return awards;
  }
}
