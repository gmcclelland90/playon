import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import { listSkills } from "./skills.js";
import { SkillDraftService } from "./skill-drafts.js";

const temps: string[] = [];

function tempConfig(): { config: AppConfig; drafts: SkillDraftService } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-draft-"));
  temps.push(root);
  const config: AppConfig = {
    port: 0,
    dataRoot: root,
    dbPath: path.join(root, "playon.db"),
    sessionSecret: "test",
    llmMode: "openai_compatible",
    runtimeMode: "docker",
    advertiseHost: "127.0.0.1",
    skillsRoots: [path.join(root, "skills")],
  };
  fs.mkdirSync(path.join(root, "skills", "_drafts"), { recursive: true });
  return { config, drafts: new SkillDraftService(config) };
}

afterEach(() => {
  for (const root of temps.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("SkillDraftService", () => {
  it("saves drafts discoverable via listSkills", () => {
    const { config, drafts } = tempConfig();
    const saved = drafts.save({
      name: "My Test Game",
      game: "My Test Game",
      description: "A draft skill",
      installGuide: "# Install\n\nRun setup.",
      containerSupport: "partial",
      warnings: "Experimental build.",
    });

    expect(saved.skillName).toBe("drafts.my-test-game");
    expect(fs.existsSync(path.join(saved.path, "metadata.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(saved.path, "guides", "INSTALL.md"))).toBe(true);
    expect(fs.existsSync(path.join(saved.path, "guides", "WARNINGS.md"))).toBe(true);

    const skills = listSkills(config.skillsRoots);
    const found = skills.find((s) => s.metadata.name === saved.skillName);
    expect(found).toBeTruthy();
    expect(found?.metadata.tags).toContain("draft");
  });

  it("promotes a draft to an installable skill", () => {
    const { config, drafts } = tempConfig();
    drafts.save({
      name: "promote-me",
      game: "Promote Me",
      description: "Draft to promote",
      installGuide: "# Install",
    });

    const promoted = drafts.promote("promote-me");
    expect(promoted.path).toContain(path.join("skills", "promote-me"));
    expect(fs.existsSync(path.join(promoted.path, "metadata.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(config.dataRoot, "skills", "_drafts", "promote-me"))).toBe(
      false,
    );

    const skills = listSkills(config.skillsRoots);
    const found = skills.find((s) => s.path === promoted.path);
    expect(found?.metadata.tags).not.toContain("draft");
  });

  it("saves and promotes a skill_module query connector", () => {
    const { config, drafts } = tempConfig();
    const saved = drafts.save({
      name: "query-draft",
      game: "Query Draft",
      description: "Has a connector",
      installGuide: "# Install",
      queryConnectorSource: `export default async function query() {
  return { online: true, players: 0, maxPlayers: 2, map: "a" };
}
`,
      queryGuide: "# Query\n\nCustom UDP.",
    });

    expect(fs.existsSync(path.join(saved.path, "query", "connector.mjs"))).toBe(true);
    expect(fs.existsSync(path.join(saved.path, "guides", "QUERY.md"))).toBe(true);
    const draftMeta = listSkills(config.skillsRoots).find((s) => s.metadata.name === saved.skillName);
    expect(draftMeta?.metadata.queryDialect).toBe("skill_module");

    const promoted = drafts.promote("query-draft");
    expect(fs.existsSync(path.join(promoted.path, "query", "connector.mjs"))).toBe(true);
    const promoMeta = listSkills(config.skillsRoots).find((s) => s.path === promoted.path);
    expect(promoMeta?.metadata.queryDialect).toBe("skill_module");
  });
});
