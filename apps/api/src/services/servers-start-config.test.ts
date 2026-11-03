import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { servers as serversTable } from "../db/schema.js";
import {
  cleanupRuntimeHandleTemps,
  fake,
  host,
  resetRuntimeHandleFakes,
  tempEnv,
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

function writeSkill(
  skillsRoot: string,
  name: string,
  game: string,
  port: number,
): void {
  const skillDir = path.join(skillsRoot, "games", name.replace(/^games\./, ""));
  fs.mkdirSync(path.join(skillDir, "guides"), { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "metadata.yaml"),
    [
      `name: ${name}`,
      "version: 0.1.0",
      `game: ${game}`,
      "containerSupport: none",
      "os:",
      "  - linux",
      "  - windows",
      "ports:",
      "  - name: game",
      "    protocol: tcp",
      `    default: ${port}`,
      "healthChecks: []",
      "dependencies: []",
      "requiredTools: []",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(skillDir, "guides", "INSTALL.md"), `# ${game}\n`);
}

beforeEach(() => {
  resetRuntimeHandleFakes();
});

afterEach(() => {
  cleanupRuntimeHandleTemps();
});

describe("start config identity across packages (#1050)", () => {
  it("allows a Paper server's own level and port and rejects a copy of them", async () => {
    const { config, db, servers } = tempEnv();
    writeSkill(path.join(config.dataRoot!, "skills"), "games.minecraft-paper", "Paper", 25565);
    servers.portsBoundOverride = async () => true;
    const live = await servers.createFromSkill({
      skillName: "games.minecraft-paper",
      serverName: "Survival",
    });
    const copy = await servers.createFromSkill({
      skillName: "games.minecraft-paper",
      serverName: "PaperCopy",
    });
    await db
      .update(serversTable)
      .set({ runtimeMode: "native" })
      .where(eq(serversTable.id, live.id));
    await db
      .update(serversTable)
      .set({ runtimeMode: "native" })
      .where(eq(serversTable.id, copy.id));

    const liveGame = path.join(live.dataPath, "game");
    const copyGame = path.join(copy.dataPath, "game");
    fs.mkdirSync(liveGame, { recursive: true });
    fs.mkdirSync(copyGame, { recursive: true });
    const properties = (level: string, port: number) =>
      [`level-name=${level}`, `server-port=${port}`, "motd=Survival night", ""].join("\n");
    fs.writeFileSync(path.join(liveGame, "start.sh"), "#!/bin/bash\nsleep 30\n");
    fs.writeFileSync(path.join(liveGame, "start.bat"), "@echo off\r\n");
    fs.writeFileSync(path.join(liveGame, "server.properties"), properties("Survival", 25565));
    fs.writeFileSync(path.join(copyGame, "start.sh"), "#!/bin/bash\nsleep 30\n");
    fs.writeFileSync(path.join(copyGame, "start.bat"), "@echo off\r\n");
    fs.writeFileSync(
      path.join(copyGame, "server.properties"),
      [
        "level-name=Survival",
        "server-port=25565",
        `# copied jail`,
        `level-seed-path=/var/lib/playon/servers/${live.id}/home`,
        "",
      ].join("\n"),
    );

    await servers.start(live.id);
    host.exited();
    await expect(servers.start(copy.id)).rejects.toThrow(
      /start_config_hardcoded: start script names Survival/,
    );
    expect(host.specs).toHaveLength(1);
    expect(host.specs[0]?.env?.PLAYON_GAME_PORT).toBe("25565");
  });

  it("allows the lab docker fixture's own volume and rejects a clone of it", async () => {
    const { db, servers } = tempEnv();
    servers.portsBoundOverride = async () => true;
    const live = await servers.createFromSkill({
      skillName: "fixtures.lab-docker-server",
      serverName: "LabWorld",
    });
    const copy = await servers.createFromSkill({
      skillName: "fixtures.lab-docker-server",
      serverName: "OtherLab",
    });
    for (const id of [live.id, copy.id]) {
      await db.update(serversTable).set({ runtimeMode: "native" }).where(eq(serversTable.id, id));
    }
    const writeLauncher = (dataPath: string, level: string, port: number, jailId: string) => {
      const gameDir = path.join(dataPath, "game");
      fs.mkdirSync(gameDir, { recursive: true });
      fs.writeFileSync(
        path.join(gameDir, "start.sh"),
        [
          "#!/usr/bin/env bash",
          `export LEVEL="\${LEVEL:-${level}}"`,
          `export SERVER_PORT="\${SERVER_PORT:-${port}}"`,
          `docker run -v /var/lib/playon/servers/${jailId}/data:/data -p ${port}:25565 itzg/minecraft-server`,
          "",
        ].join("\n"),
      );
      fs.writeFileSync(path.join(gameDir, "start.bat"), "@echo off\r\n");
    };
    writeLauncher(live.dataPath, "LabWorld", 25565, live.id);
    writeLauncher(copy.dataPath, "LabWorld", 25565, live.id);

    await servers.start(live.id);
    host.exited();
    await expect(servers.start(copy.id)).rejects.toThrow(/start_config_hardcoded/);
    expect(host.specs).toHaveLength(1);
  });

  it("allows a windows-native launcher's own port and jail and rejects a copied one", async () => {
    const { config, db, servers } = tempEnv();
    writeSkill(path.join(config.dataRoot!, "skills"), "games.bannerlord", "Bannerlord", 7210);
    servers.portsBoundOverride = async () => true;
    const live = await servers.createFromSkill({
      skillName: "games.bannerlord",
      serverName: "BannerHost",
    });
    const copy = await servers.createFromSkill({
      skillName: "games.bannerlord",
      serverName: "BannerCopy",
    });
    for (const id of [live.id, copy.id]) {
      await db.update(serversTable).set({ runtimeMode: "native" }).where(eq(serversTable.id, id));
    }
    const writeBat = (dataPath: string, name: string, port: number, jailId: string) => {
      const gameDir = path.join(dataPath, "game");
      fs.mkdirSync(gameDir, { recursive: true });
      fs.writeFileSync(path.join(gameDir, "start.sh"), "#!/bin/bash\nsleep 30\n");
      fs.writeFileSync(
        path.join(gameDir, "start.bat"),
        [
          "@echo off",
          `set "PLAYON_SERVER_NAME=${name}"`,
          `set "PLAYON_HOME=C:\\PlayOn\\servers\\${jailId}\\home"`,
          `start /b /wait "" "%EXE%" /port ${port}`,
          "",
        ].join("\r\n"),
      );
      fs.writeFileSync(
        path.join(gameDir, "start.ps1"),
        [
          `$env:PLAYON_SERVER_NAME = '${name}'`,
          `$env:PLAYON_HOME = 'C:\\PlayOn\\servers\\${jailId}\\home'`,
          "",
        ].join("\r\n"),
      );
    };
    writeBat(live.dataPath, "BannerHost", 7210, live.id);
    writeBat(copy.dataPath, "BannerHost", 7210, live.id);

    await servers.start(live.id);
    host.exited();
    await expect(servers.start(copy.id)).rejects.toThrow(
      /start_config_hardcoded: start script names BannerHost/,
    );
    expect(host.specs).toHaveLength(1);
  });
});
