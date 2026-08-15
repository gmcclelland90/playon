import { describe, expect, it } from "vitest";
import { resolveQueryDialect, SkillMetadataSchema } from "./skill.js";

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
        { id: "query", type: "query_responding", onFail: "escalate" },
      ],
    });
    expect(parsed.healthChecks).toHaveLength(3);
    expect(parsed.healthChecks[0]?.onFail).toBe("restart");
    expect(parsed.healthChecks[2]?.type).toBe("query_responding");
  });

  it("accepts project_zomboid query dialect", () => {
    const parsed = SkillMetadataSchema.parse({
      name: "games.project-zomboid",
      version: "0.1.2",
      queryDialect: "project_zomboid",
      ports: [{ name: "game", protocol: "udp", default: 16261 }],
    });
    expect(parsed.queryDialect).toBe("project_zomboid");
  });

  it("defaults games.project-zomboid to project_zomboid when metadata says none", () => {
    // Live-query mapping only. Join-ready must not treat this as wantsQuery.
    expect(resolveQueryDialect("games.project-zomboid", "none")).toBe("project_zomboid");
    expect(resolveQueryDialect("games.project-zomboid", undefined)).toBe("project_zomboid");
    expect(resolveQueryDialect("games.minecraft-paper", "none")).toBe("none");
    expect(resolveQueryDialect("games.project-zomboid", "skill_module")).toBe("skill_module");
  });

  it("accepts queryDialect and skill_module connector path", () => {
    const parsed = SkillMetadataSchema.parse({
      name: "drafts.custom-game",
      version: "0.0.1-draft",
      queryDialect: "skill_module",
      queryPortName: "query",
      queryConnector: "query/connector.mjs",
    });
    expect(parsed.queryDialect).toBe("skill_module");
    expect(parsed.queryConnector).toBe("query/connector.mjs");
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
      dockerArgs: ["--lan-server=PlayOn"],
      adminDialect: "mc_rcon",
      minRamMb: 2048,
      dependencies: ["platform.docker-basics"],
      steamAppId: undefined,
    });
    expect(parsed.dockerImage).toContain("itzg/");
    expect(parsed.dockerArgs).toEqual(["--lan-server=PlayOn"]);
    expect(parsed.adminDialect).toBe("mc_rcon");
    expect(parsed.dependencies).toEqual(["platform.docker-basics"]);
  });

  it("accepts Windows-container TTY and isolation overrides", () => {
    const parsed = SkillMetadataSchema.parse({
      name: "games.sbox-docker",
      version: "0.1.0",
      os: ["windows"],
      containerSupport: "full",
      dockerImage: "har0x/sbox-server:latest",
      dockerArgs: ["+game", "facepunch.sandbox"],
      dockerTty: true,
      dockerIsolation: "process",
      dockerDataMount: "C:\\data",
    });
    expect(parsed.dockerTty).toBe(true);
    expect(parsed.dockerIsolation).toBe("process");
    expect(parsed.dockerDataMount).toBe("C:\\data");
    expect(parsed.os).toEqual(["windows"]);
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

  it("accepts steamMod for HLDS multi-mod app 90", () => {
    const parsed = SkillMetadataSchema.parse({
      name: "games.cs-1.6",
      version: "0.1.1",
      containerSupport: "none",
      steamAppId: 90,
      steamMod: "cstrike",
      queryDialect: "a2s",
      native: {
        binary: "hlds_run",
        args: ["-game", "cstrike", "+map", "de_dust2"],
      },
    });
    expect(parsed.steamMod).toBe("cstrike");
    expect(parsed.native?.args).toContain("cstrike");
  });

  it("accepts steamBetaLinux for Linux-only SteamCMD branches", () => {
    const parsed = SkillMetadataSchema.parse({
      name: "games.humanitz",
      version: "0.1.1",
      containerSupport: "none",
      steamAppId: 2728330,
      steamBetaLinux: "linuxbranch",
      queryDialect: "a2s",
      native: { binary: "HumanitZServer.sh" },
    });
    expect(parsed.steamBetaLinux).toBe("linuxbranch");
  });

  it("stringifies finite numeric libraryPathRelative segments (YAML Steam app ids)", () => {
    const parsed = SkillMetadataSchema.parse({
      name: "games.ark-evolved",
      version: "0.1.4",
      native: {
        binary: "ShooterGame/Binaries/Linux/ShooterGameServer",
        libraryPathRelative: [
          "ShooterGame/Binaries/Linux",
          "linux64",
          ".",
          "ARK Survival Evolved Dedicated Server",
          "ARK Survival Evolved Dedicated Server/linux64",
          "ARK Survival Evolved Dedicated Server/ShooterGame/Binaries/Linux",
          376030,
          "376030/linux64",
          "376030/ShooterGame/Binaries/Linux",
        ],
      },
    });
    expect(parsed.native?.libraryPathRelative[6]).toBe("376030");
    expect(parsed.native?.libraryPathRelative.every((p) => typeof p === "string")).toBe(true);
  });

  it("rejects non-stringifiable libraryPathRelative entries", () => {
    expect(() =>
      SkillMetadataSchema.parse({
        name: "games.broken",
        version: "0.1.0",
        native: { libraryPathRelative: ["linux64", { not: "a path" }] },
      }),
    ).toThrow(/string/i);
  });
});

