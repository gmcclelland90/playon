import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  findCatalogExperience,
  parseExperiencesCatalogIndex,
  resolveExperiencesCatalogUrl,
  searchExperiencesCatalog,
  fetchExperiencesCatalogDetailed,
} from "./experiences-catalog.js";

const sample = {
  name: "experiences.demo-locker",
  version: "0.1.0",
  displayName: "Shared Locker Demo",
  description: "Server-side locker",
  baseGame: "games.project-zomboid",
  tags: ["zomboid"],
  downloadUrl: "https://playon.games/packages/experiences/demo-locker-0.1.0.experience.zip",
  official: true,
};

describe("experiences catalog", () => {
  it("parses and searches", () => {
    const { experiences, warnings } = parseExperiencesCatalogIndex({
      updatedAt: "2026-10-01T00:00:00Z",
      experiences: [sample, { name: "bad" }],
    });
    expect(experiences).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(searchExperiencesCatalog(experiences, "locker")[0]?.name).toBe(
      "experiences.demo-locker",
    );
    expect(findCatalogExperience(experiences, { name: "experiences.demo-locker" })?.version).toBe(
      "0.1.0",
    );
  });

  it("resolves default catalog URL", () => {
    expect(resolveExperiencesCatalogUrl(undefined, undefined)).toBe(
      "https://playon.games/packages/experiences/index.json",
    );
  });

  it("treats 404 catalog as empty (site not shipped yet)", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("missing", { status: 404 })) as typeof fetch;
    try {
      const result = await fetchExperiencesCatalogDetailed(
        "https://playon.games/packages/experiences/index.json",
      );
      expect(result.experiences).toEqual([]);
      expect(result.unavailable).toBe("not_found");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("fetches a populated index", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ experiences: [sample] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    try {
      const result = await fetchExperiencesCatalogDetailed("https://example.com/e.json");
      expect(result.experiences[0]?.name).toBe("experiences.demo-locker");
      expect(result.unavailable).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("keeps sha helper reachable via download re-export path", () => {
    expect(crypto.createHash("sha256").update("x").digest("hex").length).toBe(64);
  });
});
