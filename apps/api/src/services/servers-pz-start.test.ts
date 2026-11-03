import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildManagedStartEnv } from "./manage-suggest.js";
import { neutralizePzStartScript } from "./pz-start-identity.js";
import {
  cleanupRuntimeHandleTemps,
  fake,
  host,
  resetRuntimeHandleFakes,
  tempEnv,
  writePzIni,
  writePzSkill,
} from "./servers-runtime-handle-fakes.js";

vi.mock("./node-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./node-runtime.js")>();
  return {
    ...actual,
    dispatchNodeJob: () => {
      throw new Error("remote_only");
    },
  };
});

vi.mock("@playon/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@playon/runtime")>();
  const { unitRuntimeDockerStubs } = await import("../test/unit-runtime-mocks.js");
  return {
    ...actual,
    ...unitRuntimeDockerStubs(actual),
    createRuntime: async () => ({
      docker: fake.docker as never,
      process: host.supervisor,
      mode: "docker" as const,
    }),
  };
});

const CATALOG_SH = [
  "#!/usr/bin/env bash",
  "# -port 16261, -udpport 16262",
  'NAME="${PLAYON_SERVER_NAME:-servertest}"',
  'PORT="${PLAYON_GAME_PORT:-16261}"',
  'UDPPORT="${PLAYON_DIRECT_PORT:-16262}"',
  'exec "$BIN" -servername "$NAME" -port "$PORT" -udpport "$UDPPORT"',
  "",
].join("\n");

const CATALOG_BAT = [
  "@echo off",
  "REM UDP 16261",
  'if not defined PLAYON_SERVER_NAME set "PLAYON_SERVER_NAME=servertest"',
  'if not defined PLAYON_GAME_PORT set "PLAYON_GAME_PORT=16261"',
  'if not defined PLAYON_DIRECT_PORT set "PLAYON_DIRECT_PORT=16262"',
  '"%BIN%" -servername "%PLAYON_SERVER_NAME%" -port %PLAYON_GAME_PORT% -udpport %PLAYON_DIRECT_PORT%',
  "",
].join("\r\n");

function writeStartScripts(gameDir: string): void {
  fs.mkdirSync(gameDir, { recursive: true });
  fs.writeFileSync(path.join(gameDir, "start.sh"), CATALOG_SH);
  fs.writeFileSync(path.join(gameDir, "start.bat"), CATALOG_BAT);
}

beforeEach(() => {
  resetRuntimeHandleFakes();
});

afterEach(() => {
  cleanupRuntimeHandleTemps();
});

describe("PZ start identity (#1016)", () => {
  it("starts two servers from the same skill with different name, home, and ports", async () => {
    const { config, servers } = tempEnv();
    writePzSkill(path.join(config.dataRoot!, "skills"));
    servers.portsBoundOverride = async () => true;
    const hub = await servers.createFromSkill({
      skillName: "games.project-zomboid",
      serverName: "Hub",
    });
    const frontier = await servers.createFromSkill({
      skillName: "games.project-zomboid",
      serverName: "Frontier",
    });
    writePzIni(hub.dataPath, "Hub", 16271);
    writePzIni(frontier.dataPath, "Frontier", 16265);
    writeStartScripts(path.join(hub.dataPath, "game"));
    writeStartScripts(path.join(frontier.dataPath, "game"));

    await servers.start(hub.id);
    host.exited();
    await servers.start(frontier.id);

    expect(host.specs).toHaveLength(2);
    const hubEnv = host.specs[0]!.env ?? {};
    const frontierEnv = host.specs[1]!.env ?? {};
    expect(hubEnv.PLAYON_SERVER_NAME).toBe("Hub");
    expect(frontierEnv.PLAYON_SERVER_NAME).toBe("Frontier");
    expect(hubEnv.PLAYON_GAME_PORT).toBe("16271");
    expect(frontierEnv.PLAYON_GAME_PORT).toBe("16265");
    expect(hubEnv.PLAYON_DIRECT_PORT).toBe("16272");
    expect(frontierEnv.PLAYON_DIRECT_PORT).toBe("16266");
    expect(hubEnv.PLAYON_HOME).toBe(path.join(hub.dataPath, "home"));
    expect(frontierEnv.PLAYON_HOME).toBe(path.join(frontier.dataPath, "home"));
    expect(hubEnv.PLAYON_SERVER_NAME).not.toBe(frontierEnv.PLAYON_SERVER_NAME);
    expect(hubEnv.PLAYON_HOME).not.toBe(frontierEnv.PLAYON_HOME);
    expect(hubEnv.PLAYON_GAME_PORT).not.toBe(frontierEnv.PLAYON_GAME_PORT);
    expect(hubEnv.PLAYON_DIRECT_PORT).not.toBe(frontierEnv.PLAYON_DIRECT_PORT);
    expect(frontierEnv.PLAYON_GAME_PORT).not.toBe("16261");
    expect(JSON.stringify(frontierEnv)).not.toContain("NewZombieLand3");
    for (const dataPath of [hub.dataPath, frontier.dataPath]) {
      const script = fs.readFileSync(path.join(dataPath, "game", "start.sh"), "utf8");
      expect(script).toBe(neutralizePzStartScript(CATALOG_SH));
      expect(script).not.toMatch(/:-16261|:-servertest/);
    }
  });

  it("starts a clone with its own world, home, and ports when the env file still says NZL", async () => {
    const { config, servers } = tempEnv();
    writePzSkill(path.join(config.dataRoot!, "skills"));
    servers.portsBoundOverride = async () => true;
    const nzl = await servers.createFromSkill({
      skillName: "games.project-zomboid",
      serverName: "NewZombieLand3",
    });
    writePzIni(nzl.dataPath, "NewZombieLand3", 16261);
    const clone = await servers.createFromSkill({
      skillName: "games.project-zomboid",
      serverName: "NZL-Clone-Frontier-RD",
    });
    writePzIni(clone.dataPath, "NZLCloneFrontierRD", 16361);
    writePzIni(clone.dataPath, "NewZombieLand3", 16261);
    const gameDir = path.join(clone.dataPath, "game");
    writeStartScripts(gameDir);
    fs.writeFileSync(
      path.join(gameDir, ".playon-start.env"),
      buildManagedStartEnv({
        playonHome: path.join(nzl.dataPath, "home"),
        serverName: "NewZombieLand3",
        serverNameArg: "servername",
      }),
    );

    await servers.start(clone.id);

    const env = host.specs[0]?.env ?? {};
    expect(env.PLAYON_SERVER_NAME).toBe("NZLCloneFrontierRD");
    expect(env.PLAYON_GAME_PORT).toBe("16361");
    expect(env.PLAYON_DIRECT_PORT).toBe("16362");
    expect(env.PLAYON_HOME).toBe(path.join(clone.dataPath, "home"));
    expect(env.PLAYON_HOME).not.toContain(nzl.id);
    const recorded = fs.readFileSync(path.join(gameDir, ".playon-start.env"), "utf8");
    expect(recorded).toContain("NZLCloneFrontierRD");
    expect(recorded).not.toContain("NewZombieLand3");
    expect(recorded).not.toContain(nzl.id);
    expect(JSON.stringify(host.specs[0])).not.toContain("NewZombieLand3");
    expect(JSON.stringify(host.specs[0]?.args ?? [])).not.toContain("16261");
  });

  it("fails a start that has no world of its own instead of using 16261", async () => {
    const { config, servers } = tempEnv();
    writePzSkill(path.join(config.dataRoot!, "skills"));
    servers.portsBoundOverride = async () => true;
    const fresh = await servers.createFromSkill({
      skillName: "games.project-zomboid",
      serverName: "Fresh",
    });
    writeStartScripts(path.join(fresh.dataPath, "game"));

    await expect(servers.start(fresh.id)).rejects.toThrow(/start_config_missing/);
    expect(host.specs).toHaveLength(0);
    await servers.start(fresh.id).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toMatch(/16261|servertest|NewZombieLand3/);
    });
  });

  it("still refuses a second server that would bind a running peer's port", async () => {
    const { config, servers } = tempEnv();
    writePzSkill(path.join(config.dataRoot!, "skills"));
    servers.portsBoundOverride = async () => true;
    const hub = await servers.createFromSkill({
      skillName: "games.project-zomboid",
      serverName: "Hub",
    });
    const frontier = await servers.createFromSkill({
      skillName: "games.project-zomboid",
      serverName: "Frontier",
    });
    writePzIni(hub.dataPath, "Hub", 16361);
    writePzIni(frontier.dataPath, "Frontier", 16361);
    writeStartScripts(path.join(hub.dataPath, "game"));
    writeStartScripts(path.join(frontier.dataPath, "game"));

    await servers.start(hub.id);
    host.exited();
    await expect(servers.start(frontier.id)).rejects.toThrow(/start_port_collision/);
    expect(host.specs).toHaveLength(1);
  });
});
