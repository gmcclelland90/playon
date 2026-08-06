import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseCliArg,
  parseSystemdUnit,
  runManageCutover,
  unitReferencesInstall,
  worldSelectiveSources,
} from "./manage-cutover.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

describe("manage-cutover parsers", () => {
  it("parses systemd unit fields and -servername", () => {
    const unit = parseSystemdUnit(
      "zomboid.service",
      [
        "[Service]",
        "User=pzuser",
        "WorkingDirectory=/opt/pzserver",
        "ExecStart=/opt/pzserver/start-server.sh -servername NewZombieLand3",
        "",
      ].join("\n"),
    );
    expect(unit.user).toBe("pzuser");
    expect(unit.workingDirectory).toBe("/opt/pzserver");
    expect(parseCliArg(unit.execStart, "servername")).toBe("NewZombieLand3");
    expect(unitReferencesInstall(unit, "/opt/pzserver")).toBe(true);
    expect(unitReferencesInstall(unit, "/opt/other")).toBe(false);
  });

  it("parses --arg=value form", () => {
    expect(parseCliArg("./bin --servername=WorldOne", "servername")).toBe("WorldOne");
  });

  it("selects world files under userdata", () => {
    const root = mkTmp("playon-world-");
    const server = path.join(root, "Server");
    const db = path.join(root, "db");
    const saves = path.join(root, "Saves", "Multiplayer", "WorldA");
    fs.mkdirSync(server, { recursive: true });
    fs.mkdirSync(db, { recursive: true });
    fs.mkdirSync(saves, { recursive: true });
    fs.writeFileSync(path.join(server, "WorldA.ini"), "x");
    fs.writeFileSync(path.join(server, "WorldB.ini"), "y");
    fs.writeFileSync(path.join(db, "WorldA.db"), "z");
    fs.writeFileSync(path.join(db, "WorldB.db"), "w");
    const picked = worldSelectiveSources(root, "WorldA", ["Server", "db", "Saves/Multiplayer"]);
    expect(picked.some((p) => p.endsWith(`Server${path.sep}WorldA.ini`))).toBe(true);
    expect(picked.some((p) => p.endsWith(`db${path.sep}WorldA.db`))).toBe(true);
    expect(picked.some((p) => p.endsWith(`Multiplayer${path.sep}WorldA`))).toBe(true);
    expect(picked.some((p) => p.includes("WorldB"))).toBe(false);
  });
});

describe("runManageCutover", () => {
  it("copies selected world into servers/<id>/home when systemd matches", async () => {
    if (process.platform === "win32") return;

    const dataRoot = mkTmp("playon-data-");
    const unitDir = mkTmp("playon-units-");
    const fakeHomeRoot = mkTmp("playon-home-root-");
    const fakeUser = "pztest";
    const fakeHome = path.join(fakeHomeRoot, "home", fakeUser);
    const fakeInstall = path.join(fakeHome, "pzserver");
    fs.mkdirSync(fakeInstall, { recursive: true });
    fs.writeFileSync(path.join(fakeInstall, "start-server.sh"), "#!/bin/sh\n");

    const fakeZ = path.join(fakeHome, "Zomboid");
    fs.mkdirSync(path.join(fakeZ, "Server"), { recursive: true });
    fs.mkdirSync(path.join(fakeZ, "db"), { recursive: true });
    fs.mkdirSync(path.join(fakeZ, "Saves", "Multiplayer", "WorldA"), { recursive: true });
    fs.writeFileSync(path.join(fakeZ, "Server", "WorldA.ini"), "ini");
    fs.writeFileSync(path.join(fakeZ, "Server", "WorldB.ini"), "other");
    fs.writeFileSync(path.join(fakeZ, "db", "WorldA.db"), "db");
    fs.writeFileSync(path.join(fakeZ, "Saves", "Multiplayer", "WorldA", "map.bin"), "map");

    fs.writeFileSync(
      path.join(unitDir, "zomboid.service"),
      [
        "[Service]",
        `User=${fakeUser}`,
        `WorkingDirectory=${fakeInstall}`,
        `ExecStart=${fakeInstall}/start-server.sh -servername WorldA`,
        "",
      ].join("\n"),
    );

    const result = await runManageCutover(
      {
        sourcePath: fakeInstall,
        allowRoots: [path.dirname(fakeInstall)],
        homeRel: "servers/abc/home",
        manage: {
          userdataHomeDirs: ["Zomboid"],
          serverNameArg: "servername",
          adminPasswordArg: true,
          worldSubdirs: ["Server", "db", "Saves/Multiplayer"],
        },
      },
      dataRoot,
      { unitDirs: [unitDir] },
    );

    expect(result.serverName).toBe("WorldA");
    expect(result.unitName).toBe("zomboid.service");
    expect(result.userdataBytes).toBeGreaterThan(0);
    const dest = path.join(dataRoot, "servers", "abc", "home", "Zomboid");
    expect(fs.existsSync(path.join(dest, "Server", "WorldA.ini"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "db", "WorldA.db"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "Saves", "Multiplayer", "WorldA", "map.bin"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "Server", "WorldB.ini"))).toBe(false);
  });
});
