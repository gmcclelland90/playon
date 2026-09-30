import { describe, expect, it } from "vitest";
import {
  ExperienceManifestSchema,
  assertExperienceName,
} from "./experience.js";

describe("ExperienceManifestSchema", () => {
  it("accepts a minimal experiences.* pack", () => {
    const parsed = ExperienceManifestSchema.parse({
      name: "experiences.nexus-frontier-starter",
      version: "0.1.0",
      displayName: "Nexus Frontier Starter",
      baseGame: "games.project-zomboid",
      mods: [
        {
          modId: "PlayOnNexus",
          dialect: "project-zomboid",
          clientNeed: "auto",
        },
      ],
      overlays: [
        {
          path: "home/Zomboid/Server/servertest.ini",
          content: "Mods=PlayOnNexus\n",
        },
      ],
      seedFiles: ["seed/README.md"],
      panel: { summary: "PvP Frontier + Hub cure lore starter" },
    });
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.mods[0]?.dialect).toBe("project-zomboid");
  });

  it("rejects non-experiences names", () => {
    expect(() => assertExperienceName("games.foo")).toThrow(/invalid_experience_name/);
    expect(
      ExperienceManifestSchema.safeParse({
        name: "games.foo",
        version: "1",
        displayName: "x",
        baseGame: "games.paper",
      }).success,
    ).toBe(false);
  });
});
