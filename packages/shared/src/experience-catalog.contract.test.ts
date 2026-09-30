import { describe, expect, it } from "vitest";
import {
  CatalogExperienceSchema,
  CatalogExperiencesIndexSchema,
  InstallExperienceFromCatalogRequestSchema,
  buildExperienceInstallDeepLink,
  experienceInstallDeepLinkPath,
  experienceSiteDetailPath,
  resolveExperiencesCatalogUrl,
} from "./experience-catalog.js";

describe("experience catalog contract", () => {
  it("parses a catalog index entry", () => {
    const row = CatalogExperienceSchema.parse({
      name: "experiences.demo-locker",
      version: "0.1.0",
      displayName: "Shared Locker Demo",
      description: "Server-side locker mod pack",
      baseGame: "games.project-zomboid",
      tags: ["zomboid", "mod"],
      downloadUrl:
        "https://playon.games/packages/experiences/demo-locker-0.1.0.experience.zip",
      sha256: "abc",
      official: true,
      clientNeed: "none",
    });
    expect(row.name).toBe("experiences.demo-locker");
  });

  it("rejects games.* names in experiences index", () => {
    expect(
      CatalogExperienceSchema.safeParse({
        name: "games.project-zomboid",
        version: "1",
        displayName: "x",
        baseGame: "games.project-zomboid",
        downloadUrl: "https://playon.games/packages/x.experience.zip",
      }).success,
    ).toBe(false);
  });

  it("builds reversible Home deep links", () => {
    expect(experienceInstallDeepLinkPath("experiences.demo-locker")).toBe(
      "/skills?tab=experiences&name=experiences.demo-locker",
    );
    expect(
      buildExperienceInstallDeepLink({
        homeBase: "http://playon.local/",
        name: "experiences.demo-locker",
      }),
    ).toBe("http://playon.local/skills?tab=experiences&name=experiences.demo-locker");
    expect(experienceSiteDetailPath("experiences.demo-locker")).toBe(
      "/experiences/experiences.demo-locker",
    );
  });

  it("resolves catalog URL with env override", () => {
    expect(resolveExperiencesCatalogUrl(" https://example.com/e.json ", "https://stored")).toBe(
      "https://example.com/e.json",
    );
    expect(resolveExperiencesCatalogUrl(undefined, undefined)).toBe(
      "https://playon.games/packages/experiences/index.json",
    );
  });

  it("requires serverId for install-from-catalog", () => {
    expect(
      InstallExperienceFromCatalogRequestSchema.parse({
        serverId: "srv-1",
        name: "experiences.demo",
      }).serverId,
    ).toBe("srv-1");
    expect(InstallExperienceFromCatalogRequestSchema.safeParse({ name: "x" }).success).toBe(
      false,
    );
    const idx = CatalogExperiencesIndexSchema.parse({
      updatedAt: "2026-10-01T00:00:00Z",
      experiences: [],
    });
    expect(idx.experiences).toEqual([]);
  });
});
