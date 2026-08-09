import fs from "node:fs";
import path from "node:path";
import { SkillThemeIdSchema, type SkillTheme, type SkillThemeId } from "@playon/shared";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { readSkillMarker } from "./skill-marker.js";
import { loadSkillMetadata } from "./skills.js";

export type PanelTheme = {
  id: SkillThemeId;
  primaryHue?: number;
  game?: string;
  skillName?: string;
};

const DEFAULT_THEME: PanelTheme = { id: "default", primaryHue: 353 };

const THEME_HUES: Record<SkillThemeId, number> = {
  grass: 145,
  paper: 145,
  ember: 35,
  steel: 230,
  default: 353,
};

/** Sandboxed agent theme override stored under the server data dir. */
export const AgentPanelThemeSchema = z.object({
  themeId: SkillThemeIdSchema,
  primaryHue: z.number().min(0).max(360).optional(),
});
export type AgentPanelTheme = z.infer<typeof AgentPanelThemeSchema>;

function agentThemePath(dataPath: string): string {
  return path.join(dataPath, ".playon", "panel-theme.json");
}

export function readAgentPanelTheme(dataPath: string): AgentPanelTheme | null {
  try {
    const raw = JSON.parse(fs.readFileSync(agentThemePath(dataPath), "utf8")) as unknown;
    const parsed = AgentPanelThemeSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeAgentPanelTheme(dataPath: string, theme: AgentPanelTheme): AgentPanelTheme {
  const parsed = AgentPanelThemeSchema.parse(theme);
  const dir = path.dirname(agentThemePath(dataPath));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(agentThemePath(dataPath), JSON.stringify(parsed, null, 2));
  return parsed;
}

export function themeFromSkill(meta: {
  name: string;
  game?: string;
  tags: string[];
  theme?: SkillTheme;
}): PanelTheme {
  if (meta.theme) {
    return {
      id: meta.theme.id,
      primaryHue: meta.theme.primaryHue ?? THEME_HUES[meta.theme.id],
      game: meta.game,
      skillName: meta.name,
    };
  }
  const blob = [meta.name, meta.game ?? "", ...meta.tags].join(" ").toLowerCase();
  if (/minecraft|paper|grass/.test(blob)) {
    return { id: "paper", primaryHue: THEME_HUES.paper, game: meta.game, skillName: meta.name };
  }
  if (/ember|rust|ark|survival/.test(blob)) {
    return { id: "ember", primaryHue: THEME_HUES.ember, game: meta.game, skillName: meta.name };
  }
  if (/native|steel|stub|windows/.test(blob)) {
    return { id: "steel", primaryHue: THEME_HUES.steel, game: meta.game, skillName: meta.name };
  }
  return { ...DEFAULT_THEME, game: meta.game, skillName: meta.name };
}

function themeFromAgentOverride(
  override: AgentPanelTheme,
  base: Pick<PanelTheme, "game" | "skillName">,
): PanelTheme {
  return {
    id: override.themeId,
    primaryHue: override.primaryHue ?? THEME_HUES[override.themeId],
    game: base.game,
    skillName: base.skillName,
  };
}

export function resolvePanelTheme(
  config: AppConfig,
  blocks: Array<{ serverId: string | null; type?: string; sortOrder?: number }>,
): PanelTheme {
  // Prefer the primary join block's server (same idea as the player page live group).
  const ranked = [...blocks]
    .filter((b) => b.serverId)
    .sort((a, b) => {
      const aJoin = a.type === "join_info" ? 0 : 1;
      const bJoin = b.type === "join_info" ? 0 : 1;
      if (aJoin !== bJoin) return aJoin - bJoin;
      return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    });
  const serverId = ranked[0]?.serverId ?? null;
  if (!serverId) return DEFAULT_THEME;

  const dataPath = path.join(config.dataRoot, "servers", serverId);
  const skillName = readSkillMarker(dataPath)?.skillName ?? "";
  const agentOverride = readAgentPanelTheme(dataPath);

  if (agentOverride) {
    const skill = skillName ? loadSkillMetadata(config.skillsRoots, skillName) : null;
    return themeFromAgentOverride(agentOverride, {
      game: skill?.metadata.game,
      skillName: skillName || undefined,
    });
  }

  if (!skillName) return DEFAULT_THEME;
  const skill = loadSkillMetadata(config.skillsRoots, skillName);
  if (!skill) return { ...DEFAULT_THEME, skillName };
  return themeFromSkill(skill.metadata);
}
