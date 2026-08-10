import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LOCAL_NODE_ID, SkillMetadataSchema } from "@playon/shared";
import { createDb, type Db } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { nodes } from "../db/schema.js";
import type { AppConfig } from "../config.js";
import {
  PlacementService,
  scoreNodeForSkill,
  type HostCapabilityProbe,
  type NodeCaps,
} from "./placement.js";

const temps: Array<{ root: string; close: () => void }> = [];

afterEach(() => {
  for (const entry of temps.splice(0)) {
    entry.close();
    fs.rmSync(entry.root, { recursive: true, force: true });
  }
});

const windowsLocalProbe: HostCapabilityProbe = () => ({
  os: "windows",
  docker: false,
  native: true,
  steamcmd: false,
  freeDiskBytes: 20 * 1024 ** 3,
});

function placementEnv(
  skillYaml: string,
  probeHost?: HostCapabilityProbe,
): { placement: PlacementService; db: Db; skillName: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-placement-"));
  const dbPath = path.join(root, "playon.db");
  applyBootstrap(dbPath);
  const skillName = "fixtures.linux-only-demo";
  const skillDir = path.join(root, "skills", skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "metadata.yaml"), skillYaml, "utf8");
  const config: AppConfig = {
    port: 0,
    dataRoot: path.join(root, "data"),
    dbPath,
    sessionSecret: "test",
    llmMode: "openai_compatible",
    runtimeMode: "docker",
    advertiseHost: "127.0.0.1",
    skillsRoots: [path.join(root, "skills")],
  };
  fs.mkdirSync(config.dataRoot, { recursive: true });
  const { db, sqlite } = createDb(dbPath);
  temps.push({ root, close: () => sqlite.close() });
  return { placement: new PlacementService(db, config, undefined, probeHost), db, skillName };
}

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

describe("PlacementService.resolveNodeId", () => {
  const linuxOnlyYaml = `
name: fixtures.linux-only-demo
version: 1.0.0
description: linux only
os: [linux]
arch: [amd64]
containerSupport: full
dockerImage: example/demo:latest
ports:
  - name: game
    protocol: tcp
    default: 25565
`;

  it("throws no_eligible_node when Local is Windows-only for a linux skill", async () => {
    // Probe override: plan() always re-syncs Local from host caps, so DB-only OS
    // mutations are overwritten on Linux CI.
    const { placement, skillName } = placementEnv(linuxOnlyYaml, windowsLocalProbe);
    await placement.ensureLocalNode();

    await expect(placement.resolveNodeId(skillName)).rejects.toThrow(/no_eligible_node/);
    await expect(placement.resolveNodeId(skillName, LOCAL_NODE_ID)).rejects.toThrow(
      /node_ineligible:.*os_mismatch:windows/,
    );
  });

  it("returns an eligible remote linux docker node when Local cannot host", async () => {
    const { placement, db, skillName } = placementEnv(linuxOnlyYaml, windowsLocalProbe);
    await placement.ensureLocalNode();
    await db.insert(nodes).values({
      id: "lab-linux",
      name: "lab",
      os: "linux",
      docker: true,
      native: true,
      steamcmd: false,
      freeDiskBytes: 20 * 1024 ** 3,
      agentVersion: "test",
      lastSeenAt: new Date(),
      kind: "lan",
      tunnelStatus: "none",
    });

    await expect(placement.resolveNodeId(skillName)).resolves.toBe("lab-linux");
  });
});
