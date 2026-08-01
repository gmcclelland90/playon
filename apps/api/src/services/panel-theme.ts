import fs from "node:fs";
import path from "node:path";
import type { SkillTheme, SkillThemeId } from "@playon/shared";
import type { AppConfig } from "../config.js";
import { loadSkillMetadata } from "./skills.js";

export type PanelTheme = {
  id: SkillThemeId;
  primaryHue?: number;
  game?: string;
  skillName?: string;
};

const DEFAULT_THEME: PanelTheme = { id: "default" };

const THEME_HUES: Partial<Record<SkillThemeId, number>> = {
  grass: 145,
  paper: 145,
  ember: 35,
  steel: 230,
  default: 353,
};

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

export function resolvePanelTheme(
  config: AppConfig,
  blocks: Array<{ serverId: string | null }>,
): PanelTheme {
  const serverId =
    blocks.find((b) => b.serverId)?.serverId ??
    null;
  if (!serverId) return DEFAULT_THEME;

  const dataPath = path.join(config.dataRoot, "servers", serverId);
  let skillName = "";
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataPath, "skill.json"), "utf8")) as {
      skillName?: string;
    };
    skillName = raw.skillName ?? "";
  } catch {
    return DEFAULT_THEME;
  }
  if (!skillName) return DEFAULT_THEME;
  const skill = loadSkillMetadata(config.skillsRoots, skillName);
  if (!skill) return { ...DEFAULT_THEME, skillName };
  return themeFromSkill(skill.metadata);
}
