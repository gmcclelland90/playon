import { describe, expect, it } from "vitest";
import { SkillMetadataSchema } from "@playon/shared";
import { scoreNodeForSkill, type NodeCaps } from "./placement.js";

const baseSkill = SkillMetadataSchema.parse({
  name: "games.demo",
  version: "1.0.0",
  description: "demo",
  os: ["linux"],
  arch: ["amd64"],
  containerSupport: "full",
  ports: [{ name: "game", protocol: "tcp", default: 25565 }],
});

const steamSkill = SkillMetadataSchema.parse({
  name: "games.rust",
  version: "1.0.0",
  description: "rust",
  os: ["linux", "windows"],
  arch: ["amd64"],
  containerSupport: "none",
  steamAppId: 258550,
  ports: [{ name: "game", protocol: "udp", default: 28015 }],
});

function caps(partial: Partial<NodeCaps> & Pick<NodeCaps, "id" | "name">): NodeCaps {
  return {
    os: "linux",
    docker: true,
    native: true,
    steamcmd: false,
    freeDiskBytes: 20 * 1024 ** 3,
    lastSeenAt: new Date(),
    kind: "lan",
    tunnelStatus: "none",
    ...partial,
  };
}

describe("scoreNodeForSkill", () => {
  const now = Date.now();

  it("prefers online linux docker nodes", () => {
    const good = scoreNodeForSkill(
      caps({ id: "a", name: "lab", lastSeenAt: new Date(now - 1000) }),
      baseSkill,
      now,
    );
    const bad = scoreNodeForSkill(
      caps({
        id: "b",
        name: "win",
        os: "windows",
        docker: false,
        steamcmd: true,
        lastSeenAt: new Date(now - 1000),
      }),
      baseSkill,
      now,
    );
    expect(good.eligible).toBe(true);
    expect(bad.eligible).toBe(false);
    expect(good.score).toBeGreaterThan(bad.score);
    expect(good.placement).toBe("remote");
    expect(good.badge).toContain("Remote");
  });

  it("requires steamcmd for Steam skills", () => {
    const withSteam = scoreNodeForSkill(
      caps({
        id: "a",
        name: "lab",
        docker: false,
        steamcmd: true,
        lastSeenAt: new Date(now - 1000),
      }),
      steamSkill,
      now,
    );
    const without = scoreNodeForSkill(
      caps({
        id: "b",
        name: "bare",
        lastSeenAt: new Date(now - 1000),
      }),
      steamSkill,
      now,
    );
    expect(withSteam.eligible).toBe(true);
    expect(without.eligible).toBe(false);
    expect(without.reasons).toContain("steamcmd_required");
  });

  it("rejects offline or low-disk nodes", () => {
    const offline = scoreNodeForSkill(
      caps({
        id: "c",
        name: "gone",
        freeDiskBytes: 50 * 1024 ** 3,
        lastSeenAt: new Date(now - 120_000),
      }),
      baseSkill,
      now,
    );
    const lowDisk = scoreNodeForSkill(
      caps({
        id: "d",
        name: "tiny",
        freeDiskBytes: 64 * 1024 * 1024,
        lastSeenAt: new Date(now - 1000),
      }),
      baseSkill,
      now,
    );
    expect(offline.eligible).toBe(false);
    expect(lowDisk.eligible).toBe(false);
  });

  it("hides local when compute disabled", () => {
    const local = scoreNodeForSkill(
      caps({
        id: "local",
        name: "home",
        kind: "local",
        lastSeenAt: new Date(now - 1000),
      }),
      baseSkill,
      now,
      { localComputeEnabled: false },
    );
    expect(local.eligible).toBe(false);
    expect(local.reasons).toContain("local_compute_disabled");
  });

  it("rejects cloud nodes with down tunnel", () => {
    const cloud = scoreNodeForSkill(
      caps({
        id: "vps",
        name: "cloud-1",
        kind: "cloud",
        tunnelStatus: "down",
        lastSeenAt: new Date(now - 1000),
      }),
      baseSkill,
      now,
    );
    expect(cloud.eligible).toBe(false);
    expect(cloud.placement).toBe("cloud");
  });
});
