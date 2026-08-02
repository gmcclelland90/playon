import { describe, expect, it } from "vitest";
import { SkillMetadataSchema } from "./skill.js";

describe("SkillMetadataSchema contract", () => {
  it("accepts a minimal fixture skill", () => {
    const parsed = SkillMetadataSchema.parse({
      name: "games.minecraft-paper",
      version: "0.1.0",
      game: "Fake HTTP Game",
      containerSupport: "full",
      tags: ["fixture", "ci"],
      ports: [{ name: "game", protocol: "tcp", default: 8080 }],
    });
    expect(parsed.name).toBe("games.minecraft-paper");
    expect(parsed.os).toContain("linux");
  });

  it("rejects empty name", () => {
    expect(() => SkillMetadataSchema.parse({ name: "", version: "1" })).toThrow();
  });

  it("accepts skill-declared health checks", () => {
    const parsed = SkillMetadataSchema.parse({
      name: "games.minecraft-paper",
      version: "0.1.0",
      healthChecks: [
        { id: "process", type: "process_running", onFail: "restart" },
        { id: "game-port", type: "tcp_port", port: 25565, onFail: "restart" },
      ],
    });
    expect(parsed.healthChecks).toHaveLength(2);
    expect(parsed.healthChecks[0]?.onFail).toBe("restart");
  });

  it("accepts optional game-flavoured theme", () => {
    const parsed = SkillMetadataSchema.parse({
      name: "games.minecraft-paper",
      version: "0.1.0",
      theme: { id: "paper", primaryHue: 145 },
    });
    expect(parsed.theme?.id).toBe("paper");
    expect(parsed.theme?.primaryHue).toBe(145);
  });

  it("accepts docker/steam catalog fields and dependencies", () => {
    const parsed = SkillMetadataSchema.parse({
      name: "games.minecraft-paper",
      version: "0.1.0",
      containerSupport: "full",
      dockerImage: "itzg/minecraft-server:latest",
      dockerEnv: { TYPE: "PAPER", EULA: "TRUE" },
      adminDialect: "mc_rcon",
      minRamMb: 2048,
      dependencies: ["platform.docker-basics"],
      steamAppId: undefined,
    });
    expect(parsed.dockerImage).toContain("itzg/");
    expect(parsed.adminDialect).toBe("mc_rcon");
    expect(parsed.dependencies).toEqual(["platform.docker-basics"]);
  });

  it("accepts steamAppId for SteamCMD skills", () => {
    const parsed = SkillMetadataSchema.parse({
      name: "games.rust",
      version: "0.1.0",
      containerSupport: "none",
      steamAppId: 258550,
      adminDialect: "rust_web_rcon",
      dependencies: ["platform.steamcmd"],
    });
    expect(parsed.steamAppId).toBe(258550);
  });
});

