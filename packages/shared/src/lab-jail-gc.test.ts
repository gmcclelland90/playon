import { describe, expect, it } from "vitest";
import {
  classifyOrphanJail,
  identityFromSkillMarker,
  isLabFixtureServerName,
  isProtectedLiveServerName,
  jailIdentityExtras,
  planOrphanJailActions,
} from "./lab-jail-gc.js";

describe("isLabFixtureServerName", () => {
  it("recognizes disposable lab names only", () => {
    expect(isLabFixtureServerName("lab-matrix-foundry-m1k2")).toBe(true);
    expect(isLabFixtureServerName("lab-llm-canary")).toBe(true);
    expect(isLabFixtureServerName("lab-llm-canary-leftover")).toBe(true);
    expect(isLabFixtureServerName("lab-soak-paper")).toBe(true);
    expect(isLabFixtureServerName("Frontier")).toBe(false);
    expect(isLabFixtureServerName("NewZombieLand3")).toBe(false);
    expect(isLabFixtureServerName("Hub")).toBe(false);
    expect(isLabFixtureServerName("")).toBe(false);
  });
});

describe("isProtectedLiveServerName", () => {
  it("protects friend / live hosts", () => {
    expect(isProtectedLiveServerName("Frontier")).toBe(true);
    expect(isProtectedLiveServerName("NZL")).toBe(true);
    expect(isProtectedLiveServerName("NewZombieLand3")).toBe(true);
    expect(isProtectedLiveServerName("Hub")).toBe(true);
    expect(isProtectedLiveServerName("pzserver")).toBe(true);
    expect(isProtectedLiveServerName("lab-matrix-foundry-x")).toBe(false);
  });
});

describe("classifyOrphanJail", () => {
  it("purges only a positive lab signal", () => {
    expect(classifyOrphanJail({ serverName: "lab-matrix-moria-abc" })).toEqual({
      decision: "purge",
      reason: "lab_fixture",
    });
    expect(classifyOrphanJail({ labFixture: true })).toEqual({
      decision: "purge",
      reason: "lab_fixture",
    });
  });

  it("keeps unmarked leftovers and live names", () => {
    expect(classifyOrphanJail({})).toEqual({ decision: "keep", reason: "no_lab_signal" });
    expect(classifyOrphanJail({ serverName: "Frontier" })).toEqual({
      decision: "keep",
      reason: "protected_live_name",
    });
    expect(classifyOrphanJail({ serverName: "Frontier", labFixture: true })).toEqual({
      decision: "keep",
      reason: "protected_live_name",
    });
  });
});

describe("planOrphanJailActions", () => {
  it("never purges a DB row or a friend-shaped orphan", () => {
    const plan = planOrphanJailActions({
      jailIds: ["live1", "lab1", "unknown1", "frontier1"],
      keepIds: ["live1"],
      identityFor: (id) => {
        if (id === "lab1") return { serverName: "lab-matrix-l4d2-x" };
        if (id === "frontier1") return { serverName: "Frontier" };
        return {};
      },
    });
    expect(plan).toEqual([
      { id: "live1", decision: "keep", reason: "has_db_row" },
      { id: "lab1", decision: "purge", reason: "lab_fixture", serverName: "lab-matrix-l4d2-x" },
      { id: "unknown1", decision: "keep", reason: "no_lab_signal" },
      { id: "frontier1", decision: "keep", reason: "protected_live_name", serverName: "Frontier" },
    ]);
  });
});

describe("jailIdentityExtras / identityFromSkillMarker", () => {
  it("round-trips a lab name and does not mark Frontier", () => {
    expect(jailIdentityExtras("lab-matrix-foundry-aa")).toEqual({
      serverName: "lab-matrix-foundry-aa",
      labFixture: true,
    });
    expect(jailIdentityExtras("Frontier")).toEqual({ serverName: "Frontier" });
    expect(
      identityFromSkillMarker({
        skillName: "games.foundry",
        serverName: "lab-matrix-foundry-aa",
        labFixture: true,
      }),
    ).toEqual({ serverName: "lab-matrix-foundry-aa", labFixture: true });
  });
});
