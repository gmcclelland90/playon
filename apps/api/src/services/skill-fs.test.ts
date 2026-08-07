import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import { SkillFsService } from "./skill-fs.js";

const temps: string[] = [];

afterEach(() => {
  for (const root of temps.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeSkill(
  dir: string,
  name: string,
  extras?: { guide?: string },
): void {
  fs.mkdirSync(path.join(dir, "guides"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "metadata.yaml"),
    [
      `name: ${name}`,
      "version: 0.1.0",
      "game: Demo",
      "description: Test skill",
      "tags: [test]",
      "containerSupport: none",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(dir, "guides", "INSTALL.md"), extras?.guide ?? "# Install\n");
}

function tempEnv(): { config: AppConfig; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-skillfs-"));
  temps.push(root);
  const platformRoot = path.join(root, "platform");
  const installedRoot = path.join(root, "data", "skills");
  fs.mkdirSync(path.join(platformRoot, "docker-basics"), { recursive: true });
  fs.mkdirSync(path.join(root, "fixtures", "lab"), { recursive: true });
  fs.mkdirSync(path.join(installedRoot, "_drafts"), { recursive: true });

  writeSkill(path.join(platformRoot, "docker-basics"), "platform.docker-basics");
  writeSkill(path.join(root, "fixtures", "lab"), "fixtures.lab-docker-server");
  writeSkill(path.join(installedRoot, "games-demo"), "games.demo", {
    guide: "# Installed\n",
  });
  writeSkill(path.join(installedRoot, "_drafts", "scratch"), "drafts.scratch", {
    guide: "# Draft\n",
  });

  const config: AppConfig = {
    port: 0,
    dataRoot: path.join(root, "data"),
    dbPath: path.join(root, "data", "playon.db"),
    sessionSecret: "test",
    llmMode: "openai_compatible",
    runtimeMode: "docker",
    advertiseHost: "127.0.0.1",
    skillsRoots: [platformRoot, path.join(root, "fixtures"), installedRoot],
  };
  return { config, root };
}

describe("SkillFsService", () => {
  it("lists and reads installed skill files", () => {
    const { config } = tempEnv();
    const fsSvc = new SkillFsService(config);
    const entries = fsSvc.list("games.demo", ".");
    expect(entries.some((e) => e.name === "metadata.yaml" && e.type === "file")).toBe(true);
    expect(entries.some((e) => e.name === "guides" && e.type === "dir")).toBe(true);

    const file = fsSvc.read("games.demo", "guides/INSTALL.md");
    expect(file.content).toContain("# Installed");
    expect(file.writable).toBe(true);
    expect(file.source).toBe("installed");
    expect(file.truncated).toBe(false);
  });

  it("writes installed and draft skills", () => {
    const { config } = tempEnv();
    const fsSvc = new SkillFsService(config);
    const written = fsSvc.write("games.demo", "guides/INSTALL.md", "# Tweaked\n");
    expect(written.bytes).toBeGreaterThan(0);
    expect(fsSvc.read("games.demo", "guides/INSTALL.md").content).toBe("# Tweaked\n");

    fsSvc.write("drafts.scratch", "metadata.yaml", "name: drafts.scratch\nversion: 0.0.2-draft\ngame: Demo\ndescription: Edited\ntags: [draft]\ncontainerSupport: none\n");
    expect(fsSvc.read("drafts.scratch", "metadata.yaml").content).toContain("0.0.2-draft");
    expect(fsSvc.isWritable("drafts.scratch")).toBe(true);
  });

  it("refuses writes to platform and fixture skills", () => {
    const { config } = tempEnv();
    const fsSvc = new SkillFsService(config);
    expect(fsSvc.isWritable("platform.docker-basics")).toBe(false);
    expect(fsSvc.source("platform.docker-basics")).toBe("platform");
    expect(() =>
      fsSvc.write("platform.docker-basics", "guides/INSTALL.md", "nope"),
    ).toThrow(/writable_skill_required/);

    expect(fsSvc.isWritable("fixtures.lab-docker-server")).toBe(false);
    expect(() =>
      fsSvc.write("fixtures.lab-docker-server", "guides/INSTALL.md", "nope"),
    ).toThrow(/writable_skill_required/);
  });

  it("jails paths under the skill directory", () => {
    const { config } = tempEnv();
    const fsSvc = new SkillFsService(config);
    expect(() => fsSvc.list("games.demo", "..")).toThrow(/path escapes jail/);
    expect(() => fsSvc.read("games.demo", "../other.txt")).toThrow(/path escapes jail/);
    expect(() => fsSvc.write("games.demo", "../../evil.txt", "x")).toThrow(/path escapes jail/);
  });

  it("writes server-scoped skills", () => {
    const { config } = tempEnv();
    const serverSkillsRoot = path.join(config.dataRoot, "servers", "srv-1", "skills");
    writeSkill(path.join(serverSkillsRoot, "lan"), "lan-party");
    config.skillsRoots = [...config.skillsRoots, serverSkillsRoot];

    const fsSvc = new SkillFsService(config);
    expect(fsSvc.source("lan-party")).toBe("server");
    expect(fsSvc.isWritable("lan-party")).toBe(true);
    fsSvc.write("lan-party", "guides/INSTALL.md", "# Server local\n");
    expect(fsSvc.read("lan-party", "guides/INSTALL.md").content).toBe("# Server local\n");
  });
});
