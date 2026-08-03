import { describe, expect, it } from "vitest";
import { SkillMetadataSchema } from "@playon/shared";
import { scoreNodeForSkill } from "./placement.js";

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

describe("scoreNodeForSkill", () => {
  const now = Date.now();

  it("prefers online linux docker nodes", () => {
    const good = scoreNodeForSkill(
      {
        id: "a",
        name: "lab",
        os: "linux",
        docker: true,
        native: true,
        steamcmd: false,
        freeDiskBytes: 20 * 1024 ** 3,
        lastSeenAt: new Date(now - 1000),
      },
      baseSkill,
      now,
    );
    const bad = scoreNodeForSkill(
      {
        id: "b",
        name: "win",
        os: "windows",
        docker: false,
        native: true,
        steamcmd: true,
        freeDiskBytes: 20 * 1024 ** 3,
        lastSeenAt: new Date(now - 1000),
      },
      baseSkill,
      now,
    );
    expect(good.eligible).toBe(true);
    expect(bad.eligible).toBe(false);
    expect(good.score).toBeGreaterThan(bad.score);
  });

  it("requires steamcmd for Steam skills", () => {
    const withSteam = scoreNodeForSkill(
      {
        id: "a",
        name: "lab",
        os: "linux",
        docker: false,
        native: true,
        steamcmd: true,
        freeDiskBytes: 20 * 1024 ** 3,
        lastSeenAt: new Date(now - 1000),
      },
      steamSkill,
      now,
    );
    const without = scoreNodeForSkill(
      {
        id: "b",
        name: "bare",
        os: "linux",
        docker: true,
        native: true,
        steamcmd: false,
        freeDiskBytes: 20 * 1024 ** 3,
        lastSeenAt: new Date(now - 1000),
      },
      steamSkill,
      now,
    );
    expect(withSteam.eligible).toBe(true);
    expect(without.eligible).toBe(false);
    expect(without.reasons).toContain("steamcmd_required");
  });

  it("rejects offline or low-disk nodes", () => {
    const offline = scoreNodeForSkill(
      {
        id: "c",
        name: "gone",
        os: "linux",
        docker: true,
        native: true,
        steamcmd: false,
        freeDiskBytes: 50 * 1024 ** 3,
        lastSeenAt: new Date(now - 120_000),
      },
      baseSkill,
      now,
    );
    const lowDisk = scoreNodeForSkill(
      {
        id: "d",
        name: "tiny",
        os: "linux",
        docker: true,
        native: true,
        steamcmd: false,
        freeDiskBytes: 64 * 1024 * 1024,
        lastSeenAt: new Date(now - 1000),
      },
      baseSkill,
      now,
    );
    expect(offline.eligible).toBe(false);
    expect(lowDisk.eligible).toBe(false);
  });
});
