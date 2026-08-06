import path from "node:path";
import { describe, expect, it } from "vitest";
import { SkillMetadataSchema } from "@playon/shared";
import { classifySkillSource, type SkillEntry } from "./skills.js";

function entry(name: string, skillPath: string): SkillEntry {
  return {
    id: name,
    path: skillPath,
    metadata: SkillMetadataSchema.parse({
      name,
      version: "0.1.0",
      description: "test",
    }),
  };
}

describe("classifySkillSource", () => {
  const dataRoot = path.resolve("/tmp/playon-data");

  it("classifies platform, installed, draft, and fixture paths", () => {
    expect(
      classifySkillSource(
        entry("platform.docker-basics", path.join("/opt/playon/skills/platform/docker-basics")),
        dataRoot,
      ),
    ).toBe("platform");

    expect(
      classifySkillSource(
        entry("games.rust", path.join(dataRoot, "skills", "games-rust")),
        dataRoot,
      ),
    ).toBe("installed");

    expect(
      classifySkillSource(
        entry("drafts.demo", path.join(dataRoot, "skills", "_drafts", "demo")),
        dataRoot,
      ),
    ).toBe("draft");

    expect(
      classifySkillSource(
        entry("fixtures.lab-docker-server", path.join("/opt/playon/skills/fixtures/lab")),
        dataRoot,
      ),
    ).toBe("fixture");
  });
});
