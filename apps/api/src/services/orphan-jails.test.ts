import { describe, expect, it } from "vitest";
import {
  gcOrphanJails,
  mergeJailIdentity,
  parseSkillJsonIdentity,
} from "./orphan-jails.js";

describe("parseSkillJsonIdentity / mergeJailIdentity", () => {
  it("reads extras and the lab-fixture file name", () => {
    expect(
      parseSkillJsonIdentity(
        JSON.stringify({ skillName: "games.foundry", serverName: "lab-matrix-foundry-x" }),
      ),
    ).toEqual({ serverName: "lab-matrix-foundry-x", labFixture: false });
    expect(mergeJailIdentity({ serverName: "Frontier" }, "lab-matrix-x")).toEqual({
      serverName: "Frontier",
      labFixture: true,
    });
    expect(mergeJailIdentity({}, "lab-matrix-moria-1")).toEqual({
      serverName: "lab-matrix-moria-1",
      labFixture: true,
    });
  });
});

describe("gcOrphanJails", () => {
  it("stops and removes only lab fixtures, never friend leftovers", async () => {
    const stopped: string[] = [];
    const removed: string[] = [];
    const present = new Set(["lab1", "frontier1", "unknown1", "live1"]);
    const report = await gcOrphanJails(
      {
        nodeId: "playon-win-1",
        listKeepIds: async () => ["live1"],
        listJailIds: async () => ["lab1", "frontier1", "unknown1", "live1"],
        readIdentity: async (id) => {
          if (id === "lab1") return { serverName: "lab-matrix-foundry-aa", labFixture: true };
          if (id === "frontier1") return { serverName: "Frontier" };
          return {};
        },
        stopJail: async (id) => {
          stopped.push(id);
        },
        removeJail: async (id) => {
          removed.push(id);
          present.delete(id);
        },
        jailStillPresent: async (id) => present.has(id),
      },
      { dryRun: false },
    );
    expect(stopped).toEqual(["lab1"]);
    expect(removed).toEqual(["lab1"]);
    expect(report.purged).toEqual(["lab1"]);
    expect(report.kept.map((k) => k.id).sort()).toEqual(["frontier1", "unknown1"]);
    expect(report.errors).toEqual([]);
  });

  it("fails a purge when the jail remains after remove", async () => {
    const report = await gcOrphanJails({
      nodeId: "win",
      listKeepIds: async () => [],
      listJailIds: async () => ["lab1"],
      readIdentity: async () => ({ labFixture: true, serverName: "lab-matrix-x" }),
      stopJail: async () => undefined,
      removeJail: async () => undefined,
      jailStillPresent: async () => true,
    });
    expect(report.purged).toEqual([]);
    expect(report.errors).toEqual([{ id: "lab1", error: "jail_not_removed: lab1" }]);
  });

  it("dry-run lists lab fixtures without calling stop/remove", async () => {
    const stopped: string[] = [];
    const report = await gcOrphanJails(
      {
        nodeId: "win",
        listKeepIds: async () => [],
        listJailIds: async () => ["lab1"],
        readIdentity: async () => ({ labFixture: true }),
        stopJail: async (id) => {
          stopped.push(id);
        },
        removeJail: async () => {
          throw new Error("should_not_remove");
        },
        jailStillPresent: async () => true,
      },
      { dryRun: true },
    );
    expect(stopped).toEqual([]);
    expect(report.purged).toEqual(["lab1"]);
    expect(report.dryRun).toBe(true);
  });
});
