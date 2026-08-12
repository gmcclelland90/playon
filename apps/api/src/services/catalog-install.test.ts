import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { loadConfig } from "../config.js";
import { annotateCatalogInstalled, installSkillFromCatalog } from "./catalog-install.js";
import { SkillPackageService } from "./skill-packages.js";
import type { CatalogSkill } from "./skills-catalog.js";

const temps: string[] = [];

afterEach(() => {
  for (const root of temps.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function skillZip(name: string, deps: string[] = []): Uint8Array {
  const meta = [
    `name: ${name}`,
    `version: "1.0.0"`,
    `description: test`,
    `os: [linux]`,
    `arch: [amd64]`,
    `containerSupport: none`,
    `dependencies:`,
    ...deps.map((d) => `  - ${d}`),
  ].join("\n");
  return zipSync({ "metadata.yaml": new TextEncoder().encode(meta) }, { level: 6 });
}

function catalogEntry(name: string, deps: string[] = []): CatalogSkill {
  return {
    name,
    version: "1.0.0",
    tags: [],
    dependencies: deps,
    downloadUrl: `https://playon.games/packages/${name}-1.0.0.skill.zip`,
    sha256: undefined,
    official: true,
  };
}

describe("installSkillFromCatalog", () => {
  it("installs a skill and skips bundled platform deps", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-cat-"));
    temps.push(root);
    const platform = path.join(root, "skills", "platform", "steamcmd");
    fs.mkdirSync(platform, { recursive: true });
    fs.writeFileSync(
      path.join(platform, "metadata.yaml"),
      [
        "name: platform.steamcmd",
        'version: "1.0.0"',
        "description: steam",
        "os: [linux]",
        "arch: [amd64]",
        "containerSupport: none",
      ].join("\n"),
    );
    const data = path.join(root, "data");
    const config = loadConfig({
      PLAYON_DATA_ROOT: data,
      PLAYON_SKILLS_ROOT: path.join(root, "skills"),
      PLAYON_SKILLS_PROFILE: "minimal",
    });
    const pkg = new SkillPackageService(config);
    const zip = skillZip("games.demo", ["platform.steamcmd"]);
    const result = await installSkillFromCatalog({
      config,
      skillPackages: pkg,
      catalogUrl: "https://playon.games/packages/index.json",
      name: "games.demo",
      fetchCatalog: async () => [catalogEntry("games.demo", ["platform.steamcmd"])],
      downloadZip: async () => ({
        bytes: zip,
        sha256: "abc",
      }),
    });
    expect(result.skillName).toBe("games.demo");
    expect(result.installed).toContain("games.demo");
    expect(result.skippedDeps).toContain("platform.steamcmd");
    expect(fs.existsSync(path.join(data, "skills", "games-demo", "metadata.yaml"))).toBe(true);
  });

  it("rejects sha mismatches from downloadZip", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-cat-"));
    temps.push(root);
    const data = path.join(root, "data");
    const config = loadConfig({
      PLAYON_DATA_ROOT: data,
      PLAYON_SKILLS_ROOT: path.join(root, "empty-skills"),
      PLAYON_SKILLS_PROFILE: "minimal",
    });
    fs.mkdirSync(path.join(root, "empty-skills", "platform"), { recursive: true });
    const pkg = new SkillPackageService(config);
    await expect(
      installSkillFromCatalog({
        config,
        skillPackages: pkg,
        catalogUrl: "https://playon.games/packages/index.json",
        name: "games.demo",
        fetchCatalog: async () => [catalogEntry("games.demo")],
        downloadZip: async () => {
          throw new Error("catalog_sha256_mismatch: expected x got y");
        },
      }),
    ).rejects.toThrow(/catalog_sha256_mismatch/);
  });
});

describe("annotateCatalogInstalled", () => {
  it("marks local skills", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-ann-"));
    temps.push(root);
    const platform = path.join(root, "skills", "platform", "x");
    fs.mkdirSync(platform, { recursive: true });
    fs.writeFileSync(
      path.join(platform, "metadata.yaml"),
      [
        "name: platform.steamcmd",
        'version: "1.0.0"',
        "description: steam",
        "os: [linux]",
        "arch: [amd64]",
        "containerSupport: none",
      ].join("\n"),
    );
    const annotated = annotateCatalogInstalled(
      [catalogEntry("platform.steamcmd"), catalogEntry("games.rust")],
      [path.join(root, "skills", "platform")],
    );
    expect(annotated.find((s) => s.name === "platform.steamcmd")?.installed).toBe(true);
    expect(annotated.find((s) => s.name === "games.rust")?.installed).toBe(false);
  });
});
