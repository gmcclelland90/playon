import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import {
  readAgentPanelTheme,
  resolvePanelTheme,
  themeFromSkill,
  writeAgentPanelTheme,
} from "./panel-theme.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-theme-"));
  tmpDirs.push(dir);
  return dir;
}

describe("panel theme", () => {
  it("uses explicit skill theme", () => {
    const t = themeFromSkill({
      name: "games.minecraft-paper",
      game: "Minecraft (Paper)",
      tags: ["minecraft"],
      theme: { id: "paper", primaryHue: 145 },
    });
    expect(t.id).toBe("paper");
    expect(t.primaryHue).toBe(145);
  });

  it("infers paper theme from minecraft tags", () => {
    const t = themeFromSkill({
      name: "games.minecraft-paper",
      tags: ["minecraft", "paper"],
    });
    expect(t.id).toBe("paper");
  });

  it("defaults when no flavour signals", () => {
    const t = themeFromSkill({
      name: "platform.docker-basics",
      tags: ["platform"],
    });
    expect(t.id).toBe("default");
    expect(t.primaryHue).toBe(353);
  });

  it("reads and writes agent theme override under .playon", () => {
    const dataPath = path.join(tempRoot(), "servers", "srv1");
    fs.mkdirSync(dataPath, { recursive: true });
    const saved = writeAgentPanelTheme(dataPath, { themeId: "ember", primaryHue: 40 });
    expect(saved).toEqual({ themeId: "ember", primaryHue: 40 });
    expect(readAgentPanelTheme(dataPath)).toEqual({ themeId: "ember", primaryHue: 40 });
    expect(fs.existsSync(path.join(dataPath, ".playon", "panel-theme.json"))).toBe(true);
  });

  it("resolvePanelTheme prefers agent override over skill theme", () => {
    const root = tempRoot();
    const serverId = "srv-theme";
    const dataPath = path.join(root, "servers", serverId);
    fs.mkdirSync(dataPath, { recursive: true });
    fs.writeFileSync(
      path.join(dataPath, "skill.json"),
      JSON.stringify({ skillName: "games.minecraft-paper", version: "1.0.0" }),
    );
    writeAgentPanelTheme(dataPath, { themeId: "steel" });

    const config = {
      dataRoot: root,
      skillsRoots: [path.join(process.cwd(), "skills")],
    } as AppConfig;

    const theme = resolvePanelTheme(config, [
      { serverId, type: "join_info", sortOrder: 0 },
    ]);
    expect(theme.id).toBe("steel");
    expect(theme.primaryHue).toBe(230);
  });
});
