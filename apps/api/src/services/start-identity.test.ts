import { describe, expect, it } from "vitest";
import {
  iniRelForLaunchName,
  parseManagedStartEnv,
  pathBelongsToServer,
  startIsolationViolation,
  worldIniNamesFromRels,
} from "./start-identity.js";

describe("parseManagedStartEnv", () => {
  it("reads the launch name and home buildManagedStartEnv writes", () => {
    const parsed = parseManagedStartEnv(
      ['# comment', 'PLAYON_HOME="/srv/playon/servers/nzl/home"', "PLAYON_SERVER_NAME='NewZombieLand3'", ""].join(
        "\n",
      ),
    );
    expect(parsed).toEqual({
      playonHome: "/srv/playon/servers/nzl/home",
      launchName: "NewZombieLand3",
    });
  });
});

describe("pathBelongsToServer", () => {
  it("accepts this server's jail and rejects a sibling", () => {
    expect(pathBelongsToServer("/srv/playon/servers/nzl/home", "nzl")).toBe(true);
    expect(pathBelongsToServer("/srv/playon/servers/clone/home", "nzl")).toBe(false);
    expect(pathBelongsToServer("/srv/playon/nzl/home", "nzl")).toBe(false);
  });
});

describe("world ini helpers", () => {
  it("names Server/*.ini worlds and picks the launch-name file", () => {
    const rels = ["home/Zomboid/Server/NewZombieLand3.ini", "home/Zomboid/Server/Other.ini"];
    expect(worldIniNamesFromRels(rels)).toEqual(["NewZombieLand3", "Other"]);
    expect(iniRelForLaunchName(rels, "newzombieland3")).toBe(rels[0]);
    expect(iniRelForLaunchName(rels, "Missing")).toBeUndefined();
  });
});

describe("startIsolationViolation (#1016)", () => {
  const nzl = {
    id: "nzl",
    name: "NewZombieLand3",
    status: "stopped",
    launchName: "NewZombieLand3",
    gamePort: 16261,
  };

  it("allows a server that only names itself", () => {
    expect(
      startIsolationViolation({
        id: "nzl",
        identity: { launchName: "NewZombieLand3", playonHome: "/data/servers/nzl/home" },
        worldIniNames: ["NewZombieLand3"],
        gamePort: 16261,
        peers: [],
      }),
    ).toBeNull();
  });

  it("refuses a foreign PLAYON_HOME", () => {
    expect(
      startIsolationViolation({
        id: "clone",
        identity: { playonHome: "/data/servers/nzl/home" },
        worldIniNames: [],
        peers: [nzl],
      }),
    ).toMatch(/start_identity_foreign_home/);
  });

  it("refuses a launch name with no matching world ini", () => {
    expect(
      startIsolationViolation({
        id: "clone",
        identity: {
          launchName: "NewZombieLand3",
          playonHome: "/data/servers/clone/home",
        },
        worldIniNames: ["NZLCloneFrontierRD"],
        gamePort: 16361,
        peers: [nzl],
      }),
    ).toMatch(/start_identity_world_missing/);
  });

  it("refuses a clone whose launch name is another server's name", () => {
    expect(
      startIsolationViolation({
        id: "clone",
        name: "NZL-Clone-Frontier-RD",
        identity: {
          launchName: "NewZombieLand3",
          playonHome: "/data/servers/clone/home",
        },
        worldIniNames: ["NewZombieLand3"],
        gamePort: 16361,
        peers: [nzl],
      }),
    ).toMatch(/start_identity_collision/);
  });

  it("still allows NZL when a clone only copied its launch name", () => {
    expect(
      startIsolationViolation({
        id: "nzl",
        name: "NewZombieLand3",
        identity: {
          launchName: "NewZombieLand3",
          playonHome: "/data/servers/nzl/home",
        },
        worldIniNames: ["NewZombieLand3"],
        gamePort: 16261,
        peers: [
          {
            id: "clone",
            name: "NZL-Clone-Frontier-RD",
            status: "stopped",
            launchName: "NewZombieLand3",
            gamePort: 16361,
          },
        ],
      }),
    ).toBeNull();
  });

  it("refuses a game port held by a running peer and allows it when that peer is stopped", () => {
    const clone = {
      id: "clone",
      identity: { launchName: "NZLCloneFrontierRD", playonHome: "/data/servers/clone/home" },
      worldIniNames: ["NZLCloneFrontierRD"],
      gamePort: 16261,
      peers: [{ ...nzl, launchName: "NewZombieLand3", status: "running" }],
    };
    expect(startIsolationViolation(clone)).toMatch(/start_port_collision/);
    expect(
      startIsolationViolation({
        ...clone,
        peers: [{ ...nzl, status: "stopped" }],
      }),
    ).toBeNull();
  });
});
