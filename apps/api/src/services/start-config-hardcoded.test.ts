import { describe, expect, it } from "vitest";
import {
  startConfigHardcodedProblem,
  type StartConfigPeer,
  type StartConfigSelf,
} from "./start-config-hardcoded.js";

const nzl: StartConfigSelf = {
  id: "nzl",
  names: ["NewZombieLand3"],
  ports: [16261, 16262],
};
const clone: StartConfigSelf = {
  id: "clone",
  names: ["NZLCloneFrontierRD"],
  ports: [16361, 16362],
};
const nzlPeer: StartConfigPeer = {
  id: "nzl",
  names: ["NewZombieLand3"],
  ports: [16261, 16262],
};

describe("Project Zomboid start config (#1050)", () => {
  const ownFallback = [
    "#!/usr/bin/env bash",
    "# fallback is this server's own world; unused when PLAYON_SERVER_NAME is set",
    "servername=${PLAYON_SERVER_NAME:-NewZombieLand3}",
    "port=${PLAYON_GAME_PORT:-16261}",
    "udpport=${PLAYON_DIRECT_PORT:-16262}",
    'cachedir="${PLAYON_HOME:-/var/lib/playon/servers/nzl/home}/Zomboid"',
    'exec "$BIN" -cachedir "$cachedir" -servername "$servername" -port "$port" -udpport "$udpport"',
    "",
  ].join("\n");

  it("allows a server's own name, ports, and linux data dir in a fallback", () => {
    expect(startConfigHardcodedProblem({ text: ownFallback, self: nzl, peers: [] })).toBeNull();
  });

  it("rejects a clone whose fallback still names the live server", () => {
    const problem = startConfigHardcodedProblem({
      text: ownFallback,
      self: clone,
      peers: [nzlPeer],
    });
    expect(problem).toMatch(/start_config_hardcoded: start script names NewZombieLand3/);
  });

  it("rejects a foreign game port when the name was already rewritten", () => {
    const text = [
      "servername=${PLAYON_SERVER_NAME:-NZLCloneFrontierRD}",
      'exec "$BIN" -servername "$servername" -port 16261 -udpport 16262',
      "",
    ].join("\n");
    expect(
      startConfigHardcodedProblem({ text, self: clone, peers: [nzlPeer] }),
    ).toMatch(/start_config_hardcoded: start script hardcodes -port 16261/);
  });

  it("rejects a linux data dir that sits in another server's jail", () => {
    const text = [
      "servername=${PLAYON_SERVER_NAME:-NZLCloneFrontierRD}",
      'exec "$BIN" -cachedir /var/lib/playon/servers/nzl/home/Zomboid -servername "$servername"',
      "",
    ].join("\n");
    expect(
      startConfigHardcodedProblem({ text, self: clone, peers: [nzlPeer] }),
    ).toMatch(/start_config_hardcoded: start script uses another server's data dir \(nzl\)/);
  });

  it("still rejects catalog servertest / 16261 fallbacks that are not this server (#1016)", () => {
    const catalog = [
      'NAME="${PLAYON_SERVER_NAME:-servertest}"',
      'PORT="${PLAYON_GAME_PORT:-16261}"',
      'UDPPORT="${PLAYON_DIRECT_PORT:-16262}"',
      "",
    ].join("\n");
    expect(
      startConfigHardcodedProblem({ text: catalog, self: { id: "hub", names: ["Hub"], ports: [16271, 16272] }, peers: [] }),
    ).toMatch(/start_config_hardcoded: start script defaults the server name/);
    const bat = [
      "@echo off",
      'if not defined PLAYON_SERVER_NAME set "PLAYON_SERVER_NAME=servertest"',
      'if not defined PLAYON_GAME_PORT set "PLAYON_GAME_PORT=16261"',
      'if not defined PLAYON_DIRECT_PORT set "PLAYON_DIRECT_PORT=16262"',
      "",
    ].join("\r\n");
    expect(
      startConfigHardcodedProblem({ text: bat, self: { id: "hub", names: ["Hub"], ports: [16271, 16272] }, peers: [] }),
    ).toMatch(/start_config_hardcoded/);
  });

  it("ignores comments and echo lines that merely mention the live name", () => {
    const text = [
      "# previously NewZombieLand3",
      "echo backup of NewZombieLand3",
      'servername="${PLAYON_SERVER_NAME:?playon: PLAYON_SERVER_NAME is required}"',
      "",
    ].join("\n");
    expect(
      startConfigHardcodedProblem({ text, self: clone, peers: [nzlPeer] }),
    ).toBeNull();
  });

  it("allows the managed wrapper, which only forwards the control-plane env", () => {
    const text = [
      'SAVED_PLAYON_SERVER_NAME="${PLAYON_SERVER_NAME-}"',
      'if [[ -n "${SAVED_PLAYON_SERVER_NAME}" ]]; then PLAYON_SERVER_NAME="$SAVED_PLAYON_SERVER_NAME"; fi',
      'FLAG="${PLAYON_SERVER_NAME_ARG:--servername}"',
      'EXTRA+=("$FLAG" "$PLAYON_SERVER_NAME")',
      "",
    ].join("\n");
    expect(
      startConfigHardcodedProblem({ text, self: clone, peers: [nzlPeer] }),
    ).toBeNull();
  });
});

describe("Minecraft / Paper start config", () => {
  const survival: StartConfigSelf = {
    id: "paper-survival",
    names: ["Survival"],
    ports: [25565],
  };
  const copy: StartConfigSelf = {
    id: "paper-copy",
    names: ["PaperCopy"],
    ports: [25575],
  };
  const survivalPeer: StartConfigPeer = {
    id: "paper-survival",
    names: ["Survival"],
    ports: [25565],
  };

  const properties = (level: string, port: number, dataNote: string) =>
    [
      "# paper server.properties",
      `level-name=${level}`,
      `server-port=${port}`,
      "query.port=25565",
      "rcon.port=25575",
      "motd=Welcome to Survival, sister of Hub",
      `level-name-note=${dataNote}`,
      "",
    ].join("\n");

  it("allows this server's level name and port, including a motd that mentions another world", () => {
    expect(
      startConfigHardcodedProblem({
        text: properties("Survival", 25565, "ignored"),
        self: survival,
        peers: [],
      }),
    ).toBeNull();
  });

  it("rejects a copied level name and the other server's port", () => {
    expect(
      startConfigHardcodedProblem({
        text: properties("Survival", 25565, "ignored"),
        self: copy,
        peers: [survivalPeer],
      }),
    ).toMatch(/start_config_hardcoded: start script names Survival/);
  });

  it("rejects a start.sh that bind-mounts the other jail", () => {
    const text = [
      "#!/usr/bin/env bash",
      'exec java -jar paper.jar --world PaperCopy --port 25575',
      "",
    ].join("\n");
    expect(
      startConfigHardcodedProblem({ text, self: copy, peers: [survivalPeer] }),
    ).toBeNull();
    const copied = [
      "#!/usr/bin/env bash",
      "exec java -jar paper.jar --world Survival --port 25565",
      "",
    ].join("\n");
    expect(
      startConfigHardcodedProblem({ text: copied, self: copy, peers: [survivalPeer] }),
    ).toMatch(/start_config_hardcoded: start script names Survival/);
  });
});

describe("lab Docker fixture start config", () => {
  const lab: StartConfigSelf = {
    id: "lab1",
    names: ["LabWorld"],
    ports: [25565],
  };
  const other: StartConfigSelf = {
    id: "lab2",
    names: ["OtherLab"],
    ports: [25570],
  };
  const labPeer: StartConfigPeer = { id: "lab1", names: ["LabWorld"], ports: [25565] };

  function fixtureScript(level: string, port: number, jailId: string): string {
    return [
      "#!/usr/bin/env bash",
      "# fixtures.lab-docker-server (itzg PAPER)",
      `export LEVEL="\${LEVEL:-${level}}"`,
      `export SERVER_PORT="\${SERVER_PORT:-${port}}"`,
      `docker run -v /var/lib/playon/servers/${jailId}/data:/data -p ${port}:25565 itzg/minecraft-server`,
      "",
    ].join("\n");
  }

  it("allows the fixture's own level, port, and volume path", () => {
    expect(
      startConfigHardcodedProblem({
        text: fixtureScript("LabWorld", 25565, "lab1"),
        self: lab,
        peers: [],
      }),
    ).toBeNull();
  });

  it("rejects a clone that still publishes the other fixture's level, port, and volume", () => {
    const problem = startConfigHardcodedProblem({
      text: fixtureScript("LabWorld", 25565, "lab1"),
      self: other,
      peers: [labPeer],
    });
    expect(problem).toMatch(/start_config_hardcoded/);
    expect(problem).toMatch(/LabWorld|25565|lab1/);
  });
});

describe("Windows-native start config", () => {
  const hostServer: StartConfigSelf = {
    id: "banner",
    names: ["BannerHost"],
    ports: [7210],
  };
  const copied: StartConfigSelf = {
    id: "banner-copy",
    names: ["BannerCopy"],
    ports: [7211],
  };
  const hostPeer: StartConfigPeer = {
    id: "banner",
    names: ["BannerHost"],
    ports: [7210],
  };

  const bat = (name: string, port: number, jailId: string) =>
    [
      "@echo off",
      "REM PlayOn windows-native dedicated",
      `set "PLAYON_SERVER_NAME=${name}"`,
      `set "PLAYON_HOME=C:\\PlayOn\\servers\\${jailId}\\home"`,
      `start /b /wait "" "%EXE%" /port ${port} /LogOutputPath "C:\\PlayOn\\servers\\${jailId}\\game\\logs"`,
      "",
    ].join("\r\n");

  it("allows this server's name, port, and Windows jail path", () => {
    expect(
      startConfigHardcodedProblem({
        text: bat("BannerHost", 7210, "banner"),
        self: hostServer,
        peers: [],
      }),
    ).toBeNull();
  });

  it("rejects a copied start.bat that still points at the other server", () => {
    const problem = startConfigHardcodedProblem({
      text: bat("BannerHost", 7210, "banner"),
      self: copied,
      peers: [hostPeer],
    });
    expect(problem).toMatch(/start_config_hardcoded: start script names BannerHost/);
  });

  it("rejects a foreign Windows path when the name and port were already retargeted", () => {
    expect(
      startConfigHardcodedProblem({
        text: bat("BannerCopy", 7211, "banner"),
        self: copied,
        peers: [hostPeer],
      }),
    ).toMatch(/start_config_hardcoded: start script uses another server's data dir \(banner\)/);
  });

  it("reads the same identity from a PowerShell launcher", () => {
    const own = [
      "$env:PLAYON_SERVER_NAME = 'BannerHost'",
      "$env:PLAYON_HOME = 'C:\\PlayOn\\servers\\banner\\home'",
      "& $exe /port 7210",
      "",
    ].join("\r\n");
    expect(
      startConfigHardcodedProblem({ text: own, self: hostServer, peers: [] }),
    ).toBeNull();
    const foreign = [
      "$env:PLAYON_SERVER_NAME = 'BannerHost'",
      "$env:PLAYON_HOME = 'D:\\PlayOn\\servers\\banner\\home'",
      "",
    ].join("\n");
    expect(
      startConfigHardcodedProblem({ text: foreign, self: copied, peers: [hostPeer] }),
    ).toMatch(/start_config_hardcoded: start script names BannerHost/);
  });
});
