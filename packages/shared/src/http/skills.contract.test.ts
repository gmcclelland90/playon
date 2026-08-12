import { describe, expect, it } from "vitest";
import {
  ImportSkillZipRequestSchema,
  InstallSkillFromCatalogRequestSchema,
  PromoteServerSkillRequestSchema,
  SkillInUseDetailsSchema,
  skillInUseServers,
} from "./skills.js";

describe("skill route request contracts", () => {
  it("accepts either catalog identifier and rejects a malformed download url", () => {
    expect(InstallSkillFromCatalogRequestSchema.parse({ name: "games.paper" })).toEqual({
      name: "games.paper",
    });
    expect(
      InstallSkillFromCatalogRequestSchema.parse({
        downloadUrl: "https://playon.games/packages/paper.zip",
        overwrite: true,
      }).overwrite,
    ).toBe(true);
    expect(
      InstallSkillFromCatalogRequestSchema.safeParse({ downloadUrl: "not-a-url" }).success,
    ).toBe(false);
  });

  it("leaves the name-or-url choice to the route", () => {
    // Both fields are optional here; the route answers `name_or_downloadUrl_required`
    // so callers keep that text instead of a generic schema failure.
    expect(InstallSkillFromCatalogRequestSchema.safeParse({}).success).toBe(true);
  });

  it("requires zip bytes on the JSON import", () => {
    expect(ImportSkillZipRequestSchema.safeParse({ zipBase64: "" }).success).toBe(false);
    expect(ImportSkillZipRequestSchema.parse({ zipBase64: "UEsDBA==" })).toEqual({
      zipBase64: "UEsDBA==",
    });
  });

  it("requires a server and slug to promote a server skill", () => {
    const result = PromoteServerSkillRequestSchema.safeParse({ serverId: "srv-1" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual(["skillSlug"]);
  });

  it("reads the blocking servers off a skill_in_use envelope", () => {
    const details = { servers: [{ id: "srv-1", name: "Survival" }] };
    expect(SkillInUseDetailsSchema.safeParse(details).success).toBe(true);
    expect(skillInUseServers(details)).toEqual([{ id: "srv-1", name: "Survival" }]);
    expect(skillInUseServers(undefined)).toEqual([]);
    expect(skillInUseServers({ servers: "nope" })).toEqual([]);
  });
});
