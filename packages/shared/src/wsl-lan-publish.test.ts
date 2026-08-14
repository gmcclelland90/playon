import { describe, expect, it } from "vitest";
import {
  evaluateWslLanPublish,
  lanPublishPortsForSkill,
  skillHasLanJoinPort,
} from "./wsl-lan-publish.js";

describe("evaluateWslLanPublish", () => {
  it("rejects empty or loopback parent join host", () => {
    expect(
      evaluateWslLanPublish({
        parentJoinHost: "",
        parentAdvertisesPublish: true,
      }).reason,
    ).toBe("wsl_parent_join_host_unusable");
    expect(
      evaluateWslLanPublish({
        parentJoinHost: "127.0.0.1",
        parentAdvertisesPublish: true,
      }).ok,
    ).toBe(false);
  });

  it("accepts a LAN join host when the parent can publish", () => {
    const v = evaluateWslLanPublish({
      parentJoinHost: "172.16.0.94",
      parentAdvertisesPublish: true,
    });
    expect(v.ok).toBe(true);
    expect(v.reason).toBe("wsl_lan_publishable");
    expect(v.joinHost).toBe("172.16.0.94");
  });

  it("rejects NAT when the parent agent cannot publish", () => {
    const v = evaluateWslLanPublish({
      parentJoinHost: "172.16.0.94",
      parentAdvertisesPublish: false,
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("wsl_lan_publish_unavailable");
  });

  it("accepts mirrored mode without the publish job", () => {
    const v = evaluateWslLanPublish({
      parentJoinHost: "172.16.0.94",
      parentAdvertisesPublish: false,
      networkingMode: "mirrored",
    });
    expect(v.ok).toBe(true);
    expect(v.reason).toBe("wsl_lan_mirrored");
  });
});

describe("lanPublishPortsForSkill", () => {
  it("includes game, rcon, and extra TCP ports once", () => {
    expect(
      lanPublishPortsForSkill(
        {
          ports: [
            { name: "game", protocol: "tcp", default: 25565 },
            { name: "rcon", protocol: "tcp", default: 25575 },
          ],
        },
        [25575, 25565],
      ),
    ).toEqual([
      { port: 25565, protocol: "tcp" },
      { port: 25575, protocol: "tcp" },
    ]);
  });
});

describe("skillHasLanJoinPort", () => {
  it("is true when a default game port exists", () => {
    expect(skillHasLanJoinPort({ ports: [{ name: "game", protocol: "tcp", default: 25565 }] })).toBe(
      true,
    );
    expect(skillHasLanJoinPort({ ports: [] })).toBe(false);
  });
});
