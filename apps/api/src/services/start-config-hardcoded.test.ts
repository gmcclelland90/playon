import { describe, expect, it } from "vitest";
import { buildBannerlordWindowsStartBat } from "./native-launch.js";
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

describe("quoted and array identity literals (#1050 review)", () => {
  const hub: StartConfigSelf = { id: "hub", names: ["Hub"], ports: [16271, 16272] };
  const hubPeer: StartConfigPeer = { id: "hub", names: ["Hub"], ports: [16271, 16272] };
  const banner: StartConfigSelf = { id: "banner", names: ["BannerHost"], ports: [7210] };
  const bannerCopy: StartConfigSelf = { id: "banner-copy", names: ["BannerCopy"], ports: [7211] };
  const bannerPeer: StartConfigPeer = { id: "banner", names: ["BannerHost"], ports: [7210] };

  const nameHit = /start_config_hardcoded: start script names NewZombieLand3/;
  const portHit = /start_config_hardcoded: start script hardcodes -port 16261/;
  const udpHit = /start_config_hardcoded: start script hardcodes -udpport 16262/;

  function check(text: string, self: StartConfigSelf, peers: readonly StartConfigPeer[]) {
    return startConfigHardcodedProblem({ text: `${text}\n`, self, peers });
  }

  it.each([
    ['ARGS+=(-servername "NewZombieLand3")', nameHit],
    ["ARGS+=(-servername 'NewZombieLand3')", nameHit],
    ["ARGS+=(-servername NewZombieLand3)", nameHit],
    ['ARGS+=(-servername="NewZombieLand3")', nameHit],
    ["ARGS+=(-servername='NewZombieLand3')", nameHit],
    ["ARGS+=(-servername=NewZombieLand3)", nameHit],
    ['exec ./ProjectZomboid64 -servername "NewZombieLand3"', nameHit],
    ["exec ./ProjectZomboid64 -servername 'NewZombieLand3'", nameHit],
    ["exec ./ProjectZomboid64 -servername NewZombieLand3", nameHit],
    ['exec ./ProjectZomboid64 -servername="NewZombieLand3"', nameHit],
    ['ARGS+=(-servername "NewZombieLand3" -port "16261")', nameHit],
  ])("rejects a clone whose shell line is %j", (line, pattern) => {
    expect(check(line, clone, [nzlPeer])).toMatch(pattern);
  });

  it.each([
    ["ARGS+=(-port 16261)", portHit],
    ['ARGS+=(-port "16261")', portHit],
    ["ARGS+=(-port '16261')", portHit],
    ["ARGS+=(-port=16261)", portHit],
    ['ARGS+=(-port="16261")', portHit],
    ["ARGS+=(-port='16261')", portHit],
    ['exec ./ProjectZomboid64 -port "16261"', portHit],
    ["ARGS+=(-udpport 16262)", udpHit],
    ['ARGS+=(-udpport "16262")', udpHit],
    ["ARGS+=(-udpport='16262')", udpHit],
    ['ARGS+=(-udpport="16262")', udpHit],
    ["ARGS+=(-udpport=16262)", udpHit],
  ])("rejects a clone whose port line is %j", (line, pattern) => {
    expect(check(line, clone, [nzlPeer])).toMatch(pattern);
  });

  it.each([
    ['ARGS+=(-servername "NewZombieLand3")'],
    ["ARGS+=(-servername NewZombieLand3)"],
    ['exec ./ProjectZomboid64 -servername "NewZombieLand3"'],
    ["ARGS+=(-port 16261)"],
    ['ARGS+=(-port "16261")'],
    ["ARGS+=(-port=16261)"],
    ['ARGS+=(-udpport "16262")'],
    ['ARGS+=(-servername "$servername" -port "$port" -udpport "$udpport")'],
    ["ARGS+=(-servername '$servername' -port '%PLAYON_GAME_PORT%')"],
  ])("allows NZL's own shell line %j", (line) => {
    expect(check(line, nzl, [hubPeer])).toBeNull();
  });

  const nzlBackup = [
    "#!/usr/bin/env bash",
    "# bak-pre-1049 and the live launcher both keep this server's own identity",
    "servername=${PLAYON_SERVER_NAME:-NewZombieLand3}",
    "port=${PLAYON_GAME_PORT:-16261}",
    "udpport=${PLAYON_DIRECT_PORT:-16262}",
    'cachedir="${PLAYON_HOME:-/var/lib/playon/servers/nzl/home}/Zomboid"',
    "ARGS=()",
    'ARGS+=(-cachedir "$cachedir")',
    'ARGS+=(-servername "$servername")',
    'ARGS+=(-servername "NewZombieLand3")',
    "ARGS+=(-servername NewZombieLand3)",
    'ARGS+=(-port "$port")',
    "ARGS+=(-port 16261)",
    'ARGS+=(-port "16261")',
    'ARGS+=(-udpport "$udpport")',
    'ARGS+=(-udpport "16262")',
    'exec ./ProjectZomboid64 -servername "NewZombieLand3" "${ARGS[@]}"',
    "",
  ].join("\n");

  it("allows NZL's own start.sh, including the bak-pre-1049 ARGS+= fallback", () => {
    expect(startConfigHardcodedProblem({ text: nzlBackup, self: nzl, peers: [hubPeer] })).toBeNull();
  });

  it("rejects that same NZL script when a clone still carries it", () => {
    expect(startConfigHardcodedProblem({ text: nzlBackup, self: clone, peers: [nzlPeer] })).toMatch(nameHit);
  });

  const hubScript = [
    "#!/usr/bin/env bash",
    "servername=${PLAYON_SERVER_NAME:-Hub}",
    "port=${PLAYON_GAME_PORT:-16271}",
    "udpport=${PLAYON_DIRECT_PORT:-16272}",
    'cachedir="${PLAYON_HOME:-/var/lib/playon/servers/hub/home}/Zomboid"',
    'ARGS+=(-servername "Hub")',
    'ARGS+=(-port "16271")',
    'ARGS+=(-udpport "16272")',
    'exec ./ProjectZomboid64 -servername "Hub"',
    "",
  ].join("\n");

  it("allows Hub's own start.sh", () => {
    expect(startConfigHardcodedProblem({ text: hubScript, self: hub, peers: [nzlPeer] })).toBeNull();
  });

  it("rejects a clone that still launches as Hub", () => {
    expect(startConfigHardcodedProblem({ text: hubScript, self: clone, peers: [hubPeer] })).toMatch(
      /start_config_hardcoded: start script names Hub/,
    );
  });

  it("ignores the foreign identity when it is only a comment or an echo", () => {
    const text = [
      "# ARGS+=(-servername \"NewZombieLand3\")",
      "# exec ./ProjectZomboid64 -servername NewZombieLand3 -port 16261",
      'echo ARGS+=(-servername "NewZombieLand3")',
      "echo ARGS+=(-port 16261)",
      'ARGS+=(-servername "NZLCloneFrontierRD") # was NewZombieLand3',
      "",
    ].join("\n");
    expect(startConfigHardcodedProblem({ text, self: clone, peers: [nzlPeer] })).toBeNull();
  });

  it("still rejects catalog servertest / 16261 / 16262 inside arrays and quotes", () => {
    expect(check('ARGS+=(-servername "servertest")', hub, [])).toMatch(/defaults the server name/);
    expect(check("ARGS+=(-servername='servertest')", hub, [])).toMatch(/defaults the server name/);
    expect(check('ARGS+=(-port "16261")', hub, [])).toMatch(portHit);
    expect(check('ARGS+=(-udpport "16262")', hub, [])).toMatch(udpHit);
  });

  it.each([
    ['"%BIN%" -servername "NewZombieLand3" -port "16261" -udpport "16262"', nameHit],
    ['"%BIN%" -servername NewZombieLand3 -port 16261', nameHit],
    ["set \"ARGS=-servername NewZombieLand3 -port 16261\"", nameHit],
    ["set ARGS=-servername \"NewZombieLand3\"", nameHit],
    ['set "PLAYON_SERVER_NAME=NewZombieLand3"', nameHit],
  ])("rejects a copied start.bat line %j", (line, pattern) => {
    const text = ["@echo off", line, ""].join("\r\n");
    expect(startConfigHardcodedProblem({ text, self: clone, peers: [nzlPeer] })).toMatch(pattern);
  });

  it("allows NZL's own start.bat, including quoted flags", () => {
    const text = [
      "@echo off",
      "set \"PLAYON_SERVER_NAME=NewZombieLand3\"",
      "set \"PLAYON_HOME=C:\\PlayOn\\servers\\nzl\\home\"",
      '"%BIN%" -servername "NewZombieLand3" -port "16261" -udpport "16262"',
      "",
    ].join("\r\n");
    expect(startConfigHardcodedProblem({ text, self: nzl, peers: [] })).toBeNull();
  });

  it.each([
    ["& .\\ProjectZomboid64.exe -servername \"NewZombieLand3\" -port \"16261\"", nameHit],
    ["& .\\ProjectZomboid64.exe -servername 'NewZombieLand3' -port '16261'", nameHit],
    ["$args = @('-servername', 'NewZombieLand3', '-port', \"16261\")", nameHit],
    ["$args += '-servername', 'NewZombieLand3'", nameHit],
    ["$args += '-port', '16261'", portHit],
    ["$env:PLAYON_SERVER_NAME = \"NewZombieLand3\"", nameHit],
    ["$env:PLAYON_SERVER_NAME='NewZombieLand3'", nameHit],
  ])("rejects a copied start.ps1 line %j", (line, pattern) => {
    expect(check(line, clone, [nzlPeer])).toMatch(pattern);
  });

  it("rejects a PowerShell array that appends the flag and the value on two lines", () => {
    const text = [
      "$pzArgs = @()",
      "$pzArgs += '-servername'",
      "$pzArgs += 'NewZombieLand3'",
      "$pzArgs += '-port'",
      "$pzArgs += '16261'",
      "& .\\ProjectZomboid64.exe @pzArgs",
      "",
    ].join("\r\n");
    expect(startConfigHardcodedProblem({ text, self: clone, peers: [nzlPeer] })).toMatch(nameHit);
    expect(startConfigHardcodedProblem({ text, self: nzl, peers: [] })).toBeNull();
  });

  it("allows NZL's own start.ps1", () => {
    const text = [
      "$env:PLAYON_SERVER_NAME = 'NewZombieLand3'",
      "$env:PLAYON_HOME = 'C:\\PlayOn\\servers\\nzl\\home'",
      "& .\\ProjectZomboid64.exe -servername \"NewZombieLand3\" -port '16261' -udpport \"16262\"",
      "",
    ].join("\r\n");
    expect(startConfigHardcodedProblem({ text, self: nzl, peers: [hubPeer] })).toBeNull();
  });

  it.each([
    ["/port 7210"],
    ["/port \"7210\""],
    ["/port '7210'"],
    ["/port=7210"],
    ["/port=\"7210\""],
    ["/port:7210"],
    ["/Port:7210"],
  ])("allows Bannerlord %s on the server that owns 7210 and rejects a copy", (flag) => {
    const line = `start /b /wait "" "%EXE%" ${flag} /LogOutputPath "C:\\PlayOn\\servers\\banner\\game\\logs"`;
    expect(check(line, banner, [])).toBeNull();
    expect(check(line, bannerCopy, [bannerPeer])).toMatch(/start_config_hardcoded: start script hardcodes port 7210/);
  });

  it("reads the generated Bannerlord start.bat the same way", () => {
    const text = buildBannerlordWindowsStartBat();
    expect(startConfigHardcodedProblem({ text, self: banner, peers: [] })).toBeNull();
    expect(startConfigHardcodedProblem({ text, self: bannerCopy, peers: [bannerPeer] })).toMatch(
      /start_config_hardcoded: start script hardcodes port 7210/,
    );
  });

  it("rejects quoted world, identity, and publish forms for other games", () => {
    const survival = { id: "paper-survival", names: ["Survival"], ports: [25565] };
    const copy = { id: "paper-copy", names: ["PaperCopy"], ports: [25575] };
    expect(
      check('exec java -jar paper.jar --world "Survival" --port="25565"', copy, [survival]),
    ).toMatch(/start_config_hardcoded: start script names Survival/);
    expect(
      check('exec java -jar paper.jar --world "PaperCopy" --port="25575"', copy, [survival]),
    ).toBeNull();
    expect(
      check('docker run -p "25565:25565" -p=25565:25565 -p25565:25565 itzg/minecraft-server', copy, [survival]),
    ).toMatch(/start_config_hardcoded: start script hardcodes port 25565/);
    expect(
      check('docker run --publish "25575:25565" itzg/minecraft-server', copy, [survival]),
    ).toBeNull();

    const rust = { id: "rust1", names: ["RustLive"], ports: [28015] };
    const rustCopy = { id: "rust2", names: ["RustCopy"], ports: [28016] };
    expect(
      check('+server.identity "RustLive"', rustCopy, [rust]),
    ).toMatch(/start_config_hardcoded: start script names RustLive/);
    expect(check("+server.identity='RustCopy'", rustCopy, [rust])).toBeNull();
    expect(check('./RustDedicated +server.identity=RustLive', rustCopy, [rust])).toMatch(/RustLive/);

    const valheim = { id: "vh", names: ["ValheimWorld"], ports: [2456] };
    const valheimCopy = { id: "vh2", names: ["OtherWorld"], ports: [2457] };
    expect(check('./valheim_server.x86_64 -world "ValheimWorld" -name "ValheimWorld" -port "2456"', valheimCopy, [valheim])).toMatch(
      /names ValheimWorld/,
    );
    expect(check('./valheim_server.x86_64 -world "OtherWorld" --world=OtherWorld -port "2457"', valheimCopy, [valheim])).toBeNull();
    expect(check("./valheim_server -world /home/vh/worlds/ValheimWorld.db", valheimCopy, [valheim])).toBeNull();

    const factory = { id: "fac", names: ["FactorySave"], ports: [34197] };
    const factoryCopy = { id: "fac2", names: ["OtherSave"], ports: [34198] };
    expect(check('./bin/x64/factorio --start-server "FactorySave"', factoryCopy, [factory])).toMatch(/names FactorySave/);
    expect(check("./bin/x64/factorio --start-server=OtherSave", factoryCopy, [factory])).toBeNull();
    expect(check('./bin/x64/factorio --start-server "FactorySave.zip"', factoryCopy, [factory])).toBeNull();
  });
});
