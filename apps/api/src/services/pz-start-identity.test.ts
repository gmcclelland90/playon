import { describe, expect, it } from "vitest";
import { parseManagedStartEnv } from "./start-identity.js";
import {
  choosePzHome,
  neutralizePzStartScript,
  pzProcessEnv,
  pzStartScriptProblem,
  renderPzStartEnv,
  resolvePzStartIdentity,
  retargetServerPath,
  withPzNativeArgs,
} from "./pz-start-identity.js";

const nzl = { id: "nzl", name: "NewZombieLand3" };

describe("resolvePzStartIdentity (#1016)", () => {
  it("gives two servers from the same skill different names and ports", () => {
    const hub = resolvePzStartIdentity({
      id: "hub",
      name: "Hub",
      worlds: [{ name: "Hub", defaultPort: 16271, udpPort: 16272 }],
      peers: [],
    });
    const frontier = resolvePzStartIdentity({
      id: "frontier",
      name: "Frontier",
      worlds: [{ name: "Frontier", defaultPort: 16265, udpPort: 16266 }],
      peers: [nzl],
    });
    expect(hub.ok && frontier.ok).toBe(true);
    if (!hub.ok || !frontier.ok) return;
    expect(hub.identity.serverName).not.toBe(frontier.identity.serverName);
    expect(hub.identity.gamePort).not.toBe(frontier.identity.gamePort);
    expect(hub.identity.directPort).not.toBe(frontier.identity.directPort);
    expect(hub.identity.gamePort).not.toBe(16261);
    expect(frontier.identity.serverName).not.toBe("NewZombieLand3");
  });

  it("launches a clone as its own world, ignoring a copied NZL ini and name", () => {
    const clone = resolvePzStartIdentity({
      id: "clone",
      name: "NZL-Clone-Frontier-RD",
      worlds: [
        { name: "NewZombieLand3", defaultPort: 16261, udpPort: 16262 },
        { name: "NZLCloneFrontierRD", defaultPort: 16361, udpPort: 16362 },
      ],
      peers: [nzl],
    });
    expect(clone).toEqual({
      ok: true,
      identity: { serverName: "NZLCloneFrontierRD", gamePort: 16361, directPort: 16362 },
    });
  });

  it("fails when the only world belongs to another server", () => {
    const clone = resolvePzStartIdentity({
      id: "clone",
      name: "NZL-Clone-Frontier-RD",
      worlds: [{ name: "NewZombieLand3", defaultPort: 16361, udpPort: 16362 }],
      peers: [nzl],
    });
    expect(clone.ok).toBe(false);
    if (clone.ok) return;
    expect(clone.error).toMatch(/start_config_missing/);
    expect(clone.error).toMatch(/NewZombieLand3/);
    expect(clone.error).not.toMatch(/16261|servertest/);
  });

  it("fails when this server has no world ini", () => {
    const missing = resolvePzStartIdentity({
      id: "fresh",
      name: "Fresh",
      worlds: [],
      peers: [nzl],
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error).toMatch(/start_config_missing/);
    expect(missing.error).not.toMatch(/16261|servertest|NewZombieLand3/);
  });

  it("fails when the world ini has no ports", () => {
    const missingPort = resolvePzStartIdentity({
      id: "hub",
      name: "Hub",
      worlds: [{ name: "Hub", defaultPort: null, udpPort: 16272 }],
      peers: [],
    });
    expect(missingPort.ok).toBe(false);
    if (missingPort.ok) return;
    expect(missingPort.error).toMatch(/DefaultPort/);
    const missingDirect = resolvePzStartIdentity({
      id: "hub",
      name: "Hub",
      worlds: [{ name: "Hub", defaultPort: 16271, udpPort: null }],
      peers: [],
    });
    expect(missingDirect.ok).toBe(false);
    if (missingDirect.ok) return;
    expect(missingDirect.error).toMatch(/UDPPort/);
  });

  it("still lets NZL use its own world when a clone copied the launch name", () => {
    const live = resolvePzStartIdentity({
      id: "nzl",
      name: "NewZombieLand3",
      worlds: [{ name: "NewZombieLand3", defaultPort: 16261, udpPort: 16262 }],
      peers: [{ id: "clone", name: "NZL-Clone-Frontier-RD" }],
    });
    expect(live).toEqual({
      ok: true,
      identity: { serverName: "NewZombieLand3", gamePort: 16261, directPort: 16262 },
    });
  });
});

describe("choosePzHome", () => {
  it("uses this server's jail and drops a copied NZL home", () => {
    expect(
      choosePzHome({
        serverId: "clone",
        remote: false,
        localHome: "/data/servers/clone/home",
        inheritedHome: "/data/servers/nzl/home",
      }),
    ).toEqual({ home: "/data/servers/clone/home" });
  });

  it("retargets a remote absolute home onto this server id", () => {
    expect(retargetServerPath("/var/lib/playon-node/servers/nzl/home", "clone")).toBe(
      "/var/lib/playon-node/servers/clone/home",
    );
    expect(
      choosePzHome({
        serverId: "clone",
        remote: true,
        localHome: "/home-mirror/servers/clone/home",
        inheritedHome: "/var/lib/playon-node/servers/nzl/home",
      }),
    ).toEqual({ home: "/var/lib/playon-node/servers/clone/home" });
  });

  it("refuses a remote home that is not a servers/<id> path", () => {
    const chosen = choosePzHome({
      serverId: "clone",
      remote: true,
      localHome: "/data/servers/clone/home",
      inheritedHome: "/opt/pzserver",
    });
    expect(chosen.error).toMatch(/start_config_home/);
  });
});

describe("renderPzStartEnv", () => {
  it("replaces a copied NZL identity and keeps the admin password", () => {
    const rendered = renderPzStartEnv(
      [
        "PLAYON_HOME=/data/servers/nzl/home",
        'PLAYON_SERVER_NAME="NewZombieLand3"',
        'PLAYON_ADMIN_PASSWORD="secret"',
        "",
      ].join("\n"),
      {
        serverName: "NZLCloneFrontierRD",
        gamePort: 16361,
        directPort: 16362,
        playonHome: "/data/servers/clone/home",
      },
    );
    expect(rendered).not.toContain("NewZombieLand3");
    expect(rendered).not.toContain("/data/servers/nzl/home");
    expect(parseManagedStartEnv(rendered)).toEqual({
      launchName: "NZLCloneFrontierRD",
      playonHome: "/data/servers/clone/home",
    });
    expect(rendered).toContain('PLAYON_ADMIN_PASSWORD="secret"');
    expect(rendered).toContain('PLAYON_GAME_PORT="16361"');
    expect(rendered).toContain('PLAYON_DIRECT_PORT="16362"');
    expect(pzProcessEnv({
      serverName: "NZLCloneFrontierRD",
      gamePort: 16361,
      directPort: 16362,
      playonHome: "/data/servers/clone/home",
    })).toEqual({
      PLAYON_SERVER_NAME: "NZLCloneFrontierRD",
      PLAYON_GAME_PORT: "16361",
      PLAYON_DIRECT_PORT: "16362",
      PLAYON_HOME: "/data/servers/clone/home",
    });
  });
});

describe("PZ start argv defaults", () => {
  const catalogSh = [
    "#!/usr/bin/env bash",
    "# execs ProjectZomboid64 with -cachedir, -port 16261, -udpport 16262.",
    'NAME="${PLAYON_SERVER_NAME:-servertest}"',
    'PORT="${PLAYON_GAME_PORT:-16261}"',
    'UDPPORT="${PLAYON_DIRECT_PORT:-16262}"',
    'exec "$BIN" -cachedir="$CACHE" -servername "$NAME" -port "$PORT" -udpport "$UDPPORT"',
    "",
  ].join("\n");

  const catalogBat = [
    "@echo off",
    "REM UDP 16261 binds",
    'if not defined PLAYON_SERVER_NAME set "PLAYON_SERVER_NAME=servertest"',
    'if not defined PLAYON_GAME_PORT set "PLAYON_GAME_PORT=16261"',
    'if not defined PLAYON_DIRECT_PORT set "PLAYON_DIRECT_PORT=16262"',
    '"%BIN%" -servername "%PLAYON_SERVER_NAME%" -port %PLAYON_GAME_PORT% -udpport %PLAYON_DIRECT_PORT%',
    "",
  ].join("\r\n");

  it("rewrites catalog fallbacks so a missing value cannot become servertest or 16261", () => {
    for (const original of [catalogSh, catalogBat]) {
      expect(pzStartScriptProblem(original)).toMatch(/start_config_hardcoded/);
      const patched = neutralizePzStartScript(original);
      expect(pzStartScriptProblem(patched)).toBeNull();
      expect(patched).not.toMatch(/:-servertest|:-16261|:-16262|PLAYON_SERVER_NAME=servertest/);
      expect(patched).toMatch(/PLAYON_SERVER_NAME is required/);
    }
  });

  it("refuses a script that still hardcodes NewZombieLand3", () => {
    expect(pzStartScriptProblem('exec "$BIN" -servername NewZombieLand3 -port 16261\n')).toMatch(
      /NewZombieLand3/,
    );
  });

  it("builds argv from this server and strips baked-in servertest / 16261", () => {
    expect(
      withPzNativeArgs(
        ["-nosteam", "-port", "16261", "-udpport", "16262", "-servername", "servertest"],
        {
          serverName: "NZLCloneFrontierRD",
          gamePort: 16361,
          directPort: 16362,
          cacheDir: "/data/servers/clone/home/Zomboid",
        },
      ),
    ).toEqual([
      "-nosteam",
      "-cachedir",
      "/data/servers/clone/home/Zomboid",
      "-servername",
      "NZLCloneFrontierRD",
      "-port",
      "16361",
      "-udpport",
      "16362",
    ]);
    expect(
      withPzNativeArgs(["-port", "16261", "-servername", "NewZombieLand3"], null),
    ).toEqual([]);
  });
});
