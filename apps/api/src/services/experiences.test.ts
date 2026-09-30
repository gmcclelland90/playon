import { describe, expect, it } from "vitest";
import { ExperienceManifestSchema } from "@playon/shared";
import {
  buildExperienceZip,
  parseExperienceZip,
  planExperienceInstall,
  ExperiencePackageError,
} from "./experiences.js";
import { FIXTURE_SERIALIZE_BAD, FIXTURE_SERIALIZE_GOOD } from "./mods-lua-check.js";

const baseManifest = ExperienceManifestSchema.parse({
  name: "experiences.demo-pack",
  version: "0.1.0",
  displayName: "Demo Pack",
  baseGame: "games.project-zomboid",
  mods: [{ modId: "DemoMod", dialect: "project-zomboid", clientNeed: "none" }],
  overlays: [{ path: "home/Zomboid/Server/servertest.ini", content: "Mods=DemoMod\n" }],
  seedFiles: ["seed/README.md"],
  panel: { summary: "Demo experience" },
});

describe("experiences package", () => {
  it("round-trips zip build/parse and plans install", () => {
    const files = {
      "mods/DemoMod/mod.info": "name=Demo\nid=DemoMod\n",
      "mods/DemoMod/media/lua/server/demo.lua": FIXTURE_SERIALIZE_GOOD,
      "seed/README.md": "seed notes\n",
    };
    const built = buildExperienceZip({ manifest: baseManifest, files });
    expect(built.filename).toBe("demo-pack-0.1.0.experience.zip");
    const parsed = parseExperienceZip(built.bytes);
    expect(parsed.manifest.name).toBe("experiences.demo-pack");
    expect(parsed.files["seed/README.md"]).toContain("seed notes");
    const plan = planExperienceInstall(parsed);
    expect(plan.modIds).toEqual(["DemoMod"]);
    expect(plan.overlayPaths[0]).toContain("servertest.ini");
    expect(plan.seedPaths).toContain("seed/README.md");
  });

  it("hard-fails export when PZ lua footguns are present", () => {
    expect(() =>
      buildExperienceZip({
        manifest: baseManifest,
        files: {
          "mods/DemoMod/media/lua/shared/Utils.lua": FIXTURE_SERIALIZE_BAD,
        },
      }),
    ).toThrow(ExperiencePackageError);
  });
});
