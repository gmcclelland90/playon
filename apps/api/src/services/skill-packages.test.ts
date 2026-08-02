import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import { SkillPackageService } from "./skill-packages.js";
import { listSkills } from "./skills.js";

const temps: string[] = [];

afterEach(() => {
  for (const root of temps.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempConfig(): AppConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-skillpkg-"));
  temps.push(root);
  const skillDir = path.join(root, "skills", "demo");
  fs.mkdirSync(path.join(skillDir, "guides"), { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "metadata.yaml"),
    [
      "name: demo.skill",
      "version: 1.2.3",
      "game: Demo",
      "description: Pack me",
      "tags: [test]",
      "containerSupport: none",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(skillDir, "guides", "INSTALL.md"), "# Install\n");
  return {
    port: 0,
    dataRoot: root,
    dbPath: path.join(root, "playon.db"),
    sessionSecret: "test",
    llmMode: "openai_compatible",
    runtimeMode: "docker",
    advertiseHost: "127.0.0.1",
    skillsRoots: [path.join(root, "skills")],
  };
}

describe("SkillPackageService", () => {
  it("round-trips export and import", () => {
    const config = tempConfig();
    const pkg = new SkillPackageService(config);
    const exported = pkg.exportZip("demo.skill");
    expect(exported.filename).toContain("demo-skill");
    expect(exported.bytes.byteLength).toBeGreaterThan(32);

    fs.rmSync(path.join(config.dataRoot, "skills", "demo"), { recursive: true, force: true });
    expect(listSkills(config.skillsRoots).some((s) => s.metadata.name === "demo.skill")).toBe(
      false,
    );

    const imported = pkg.importZip(exported.bytes);
    expect(imported.skillName).toBe("demo.skill");
    expect(imported.version).toBe("1.2.3");
    expect(fs.existsSync(path.join(imported.path, "guides", "INSTALL.md"))).toBe(true);
    expect(listSkills(config.skillsRoots).some((s) => s.metadata.name === "demo.skill")).toBe(
      true,
    );
  });

  it("promotes a per-server skill to global", () => {
    const config = tempConfig();
    const pkg = new SkillPackageService(config);
    const serverSkill = path.join(config.dataRoot, "servers", "srv1", "skills", "lan-party");
    fs.mkdirSync(path.join(serverSkill, "guides"), { recursive: true });
    fs.writeFileSync(
      path.join(serverSkill, "metadata.yaml"),
      [
        "name: lan-party",
        "version: 0.2.0",
        "game: LAN",
        "description: Server-local",
        "tags: [local]",
        "containerSupport: none",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(serverSkill, "guides", "INSTALL.md"), "# Local\n");

    const promoted = pkg.promoteServerSkill("srv1", "lan-party");
    expect(promoted.path).toBe(path.join(config.dataRoot, "skills", "lan-party"));
    expect(listSkills(config.skillsRoots).some((s) => s.metadata.name === "lan-party")).toBe(true);
  });

  it("rejects zip path traversal", () => {
    const config = tempConfig();
    const pkg = new SkillPackageService(config);
    const evil = zipSync({
      "../escape.yaml": strToU8("x: 1"),
      "metadata.yaml": strToU8(
        [
          "name: evil",
          "version: 0.0.1",
          "game: Evil",
          "description: no",
          "tags: []",
          "containerSupport: none",
        ].join("\n"),
      ),
    });
    expect(() => pkg.importZip(evil)).toThrow(/unsafe_zip_path/);
  });
});
