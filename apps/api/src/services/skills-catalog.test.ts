import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CatalogIndexSchema,
  downloadCatalogSkillZip,
  findCatalogSkill,
  resolveSkillsCatalogUrl,
  searchCatalog,
} from "./skills-catalog.js";

describe("skills catalog", () => {
  it("parses index shape", () => {
    const idx = CatalogIndexSchema.parse({
      updatedAt: "2026-08-02T00:00:00Z",
      skills: [
        {
          name: "games.minecraft-paper",
          version: "0.1.0",
          downloadUrl: "https://playon.games/skills/packages/games.minecraft-paper-0.1.0.skill.zip",
          tags: ["minecraft"],
        },
      ],
    });
    expect(idx.skills).toHaveLength(1);
  });

  it("searches by name and tags", () => {
    const skills = CatalogIndexSchema.parse({
      skills: [
        {
          name: "games.rust",
          version: "0.1.0",
          downloadUrl: "https://example.com/a.skill.zip",
          tags: ["rust", "steam"],
          description: "Rust dedicated",
        },
        {
          name: "games.minecraft-paper",
          version: "0.1.0",
          downloadUrl: "https://example.com/b.skill.zip",
          tags: ["minecraft"],
        },
      ],
    }).skills;
    expect(searchCatalog(skills, "rust")).toHaveLength(1);
    expect(searchCatalog(skills, "minecraft")).toHaveLength(1);
  });

  it("resolves catalog url with env override", () => {
    expect(resolveSkillsCatalogUrl(" https://example.com/index.json ", "https://stored")).toBe(
      "https://example.com/index.json",
    );
    expect(resolveSkillsCatalogUrl(undefined, "https://stored")).toBe("https://stored");
    expect(resolveSkillsCatalogUrl(undefined, undefined)).toBe(
      "https://playon.games/skills/index.json",
    );
  });

  it("finds catalog skills by name or downloadUrl", () => {
    const skills = CatalogIndexSchema.parse({
      skills: [
        {
          name: "games.rust",
          version: "0.1.0",
          downloadUrl: "https://playon.games/skills/packages/games.rust-0.1.0.skill.zip",
          tags: ["rust"],
        },
        {
          name: "games.minecraft-paper",
          version: "0.1.0",
          downloadUrl: "https://playon.games/skills/packages/games.minecraft-paper-0.1.0.skill.zip",
          tags: ["minecraft"],
        },
      ],
    }).skills;
    expect(findCatalogSkill(skills, { name: "games.rust" })?.name).toBe("games.rust");
    expect(findCatalogSkill(skills, { name: "minecraft" })?.name).toBe("games.minecraft-paper");
    expect(
      findCatalogSkill(skills, {
        downloadUrl: "https://playon.games/skills/packages/games.rust-0.1.0.skill.zip",
      })?.name,
    ).toBe("games.rust");
  });

  it("downloads and verifies sha256", async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const expected = crypto.createHash("sha256").update(payload).digest("hex");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(payload, {
        status: 200,
        headers: { "content-type": "application/zip" },
      })) as typeof fetch;
    try {
      const { bytes, sha256 } = await downloadCatalogSkillZip(
        "https://playon.games/skills/packages/demo.skill.zip",
        expected,
      );
      expect(bytes).toEqual(payload);
      expect(sha256).toBe(expected);
      await expect(
        downloadCatalogSkillZip("https://playon.games/skills/packages/demo.skill.zip", "deadbeef"),
      ).rejects.toThrow(/sha256_mismatch/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects non-https downloads", async () => {
    await expect(downloadCatalogSkillZip("http://example.com/x.skill.zip")).rejects.toThrow(
      /https_required/,
    );
  });
});

