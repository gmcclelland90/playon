import { describe, expect, it } from "vitest";
import type { SkillMetadata } from "@playon/shared";
import { scoreNodeForSkill } from "./placement.js";

const baseSkill: SkillMetadata = {
  name: "games.demo",
  version: "1.0.0",
  description: "demo",
  tags: [],
  os: ["linux"],
  arch: ["amd64"],
  containerSupport: "full",
  requiredTools: [],
  ports: [{ name: "game", protocol: "tcp", default: 25565 }],
  dependencies: [],
  healthChecks: [],
};

describe("scoreNodeForSkill", () => {
  const now = Date.now();

  it("prefers online linux docker nodes", () => {
    const good = scoreNodeForSkill(
      {
        id: "a",
        name: "lab",
        os: "linux",
        docker: true,
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

  it("rejects offline or low-disk nodes", () => {
    const offline = scoreNodeForSkill(
      {
        id: "c",
        name: "gone",
        os: "linux",
        docker: true,
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
