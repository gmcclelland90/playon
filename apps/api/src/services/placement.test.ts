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
  applyWslLanPlacement,
  PlacementService,
  scoreNodeForSkill,
  type HostCapabilityProbe,
  type NodeCaps,
} from "./placement.js";
import type { NetToolsService } from "./net-tools.js";
import { nodeJobService } from "./node-jobs.js";

const temps: Array<{ root: string; close: () => void }> = [];

afterEach(() => {
  nodeJobService.forgetJobKinds("playon-win-1");
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
  net?: NetToolsService,
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
  return { placement: new PlacementService(db, config, net, probeHost), db, skillName };
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

const windowsDockerSkill = SkillMetadataSchema.parse({
  name: "games.sbox-docker",
  version: "1.0.0",
  description: "windows container",
  os: ["windows"],
  arch: ["amd64"],
  containerSupport: "full",
  dockerImage: "har0x/sbox-server:latest",
  ports: [{ name: "game", protocol: "udp", default: 27015 }],
});

describe("scoreNodeForSkill windows containers", () => {
  const now = Date.now();

  it("places a Windows-container skill on a Windows node with docker", () => {
    const win = scoreNodeForSkill(
      caps({
        id: "playon-win-1",
        name: "win",
        os: "windows",
        docker: true,
        steamcmd: true,
        lastSeenAt: new Date(now - 1000),
      }),
      windowsDockerSkill,
      now,
    );
    expect(win.eligible).toBe(true);
    expect(win.reasons).toContain("docker_ready");
    expect(win.reasons).toContain("os_ok:windows");
  });

  it("rejects a Windows-container skill when the Windows node has no Windows docker", () => {
    const win = scoreNodeForSkill(
      caps({
        id: "playon-win-1",
        name: "win",
        os: "windows",
        docker: false,
        steamcmd: true,
        lastSeenAt: new Date(now - 1000),
      }),
      windowsDockerSkill,
      now,
    );
    expect(win.eligible).toBe(false);
    expect(win.reasons).toContain("docker_required");
  });

  it("does not place a Windows-container skill on a Linux WSL sibling", () => {
    const wsl = scoreNodeForSkill(
      caps({
        id: "playon-win-1-wsl",
        name: "win-wsl",
        os: "linux",
        docker: true,
        lastSeenAt: new Date(now - 1000),
      }),
      windowsDockerSkill,
      now,
    );
    expect(wsl.eligible).toBe(false);
    expect(wsl.reasons).toContain("os_mismatch:linux");
  });

  it("still places linux docker skills on the WSL sibling, not the Windows parent", () => {
    const win = scoreNodeForSkill(
      caps({
        id: "playon-win-1",
        name: "win",
        os: "windows",
        docker: true,
        lastSeenAt: new Date(now - 1000),
      }),
      baseSkill,
      now,
    );
    const wsl = scoreNodeForSkill(
      caps({
        id: "playon-win-1-wsl",
        name: "win-wsl",
        os: "linux",
        docker: true,
        lastSeenAt: new Date(now - 1000),
      }),
      baseSkill,
      now,
    );
    expect(win.eligible).toBe(false);
    expect(win.reasons).toContain("os_mismatch:windows");
    expect(wsl.eligible).toBe(true);
    expect(wsl.reasons).toContain("docker_ready");
  });
});

describe("applyWslLanPlacement", () => {
  const now = Date.now();

  it("marks WSL ineligible when the parent cannot publish a LAN join host", () => {
    const wsl = scoreNodeForSkill(
      caps({
        id: "playon-win-1-wsl",
        name: "win-wsl",
        lastSeenAt: new Date(now - 1000),
      }),
      baseSkill,
      now,
    );
    const local = scoreNodeForSkill(
      caps({
        id: "local",
        name: "home",
        kind: "local",
        lastSeenAt: new Date(now - 1000),
      }),
      baseSkill,
      now,
    );
    expect(wsl.eligible).toBe(true);
    applyWslLanPlacement(
      [wsl, local],
      [
        caps({
          id: "playon-win-1",
          name: "win",
          os: "windows",
          joinHost: "172.16.0.94",
          lastSeenAt: new Date(now - 1000),
        }),
        caps({ id: "playon-win-1-wsl", name: "win-wsl", lastSeenAt: new Date(now - 1000) }),
        caps({ id: "local", name: "home", kind: "local", lastSeenAt: new Date(now - 1000) }),
      ],
      baseSkill,
      "127.0.0.1",
    );
    expect(wsl.eligible).toBe(false);
    expect(wsl.reasons).toContain("wsl_lan_publish_unavailable");
    expect(local.eligible).toBe(true);
  });

  it("keeps WSL eligible when the parent advertises net_port_publish", () => {
    nodeJobService.advertiseJobKinds("playon-win-1", ["net_port_publish"]);
    const wsl = scoreNodeForSkill(
      caps({
        id: "playon-win-1-wsl",
        name: "win-wsl",
        lastSeenAt: new Date(now - 1000),
      }),
      baseSkill,
      now,
    );
    applyWslLanPlacement(
      [wsl],
      [
        caps({
          id: "playon-win-1",
          name: "win",
          os: "windows",
          joinHost: "172.16.0.94",
          lastSeenAt: new Date(now - 1000),
        }),
        caps({ id: "playon-win-1-wsl", name: "win-wsl", lastSeenAt: new Date(now - 1000) }),
      ],
      baseSkill,
      "127.0.0.1",
    );
    expect(wsl.eligible).toBe(true);
    expect(wsl.reasons).toContain("wsl_lan_publishable");
  });

  it("marks WSL ineligible when parent join_host is loopback", () => {
    nodeJobService.advertiseJobKinds("playon-win-1", ["net_port_publish"]);
    const wsl = scoreNodeForSkill(
      caps({
        id: "playon-win-1-wsl",
        name: "win-wsl",
        lastSeenAt: new Date(now - 1000),
      }),
      baseSkill,
      now,
    );
    applyWslLanPlacement(
      [wsl],
      [
        caps({
          id: "playon-win-1",
          name: "win",
          os: "windows",
          joinHost: "127.0.0.1",
          lastSeenAt: new Date(now - 1000),
        }),
        caps({ id: "playon-win-1-wsl", name: "win-wsl", lastSeenAt: new Date(now - 1000) }),
      ],
      baseSkill,
      "127.0.0.1",
    );
    expect(wsl.eligible).toBe(false);
    expect(wsl.reasons).toContain("wsl_parent_join_host_unusable");
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

  it("does not recommend a WSL sibling when the parent cannot publish LAN", async () => {
    const { placement, db, skillName } = placementEnv(linuxOnlyYaml, windowsLocalProbe);
    await placement.ensureLocalNode();
    await db.insert(nodes).values({
      id: "playon-win-1",
      name: "win",
      os: "windows",
      docker: false,
      native: true,
      steamcmd: true,
      freeDiskBytes: 20 * 1024 ** 3,
      agentVersion: "test",
      lastSeenAt: new Date(),
      kind: "lan",
      tunnelStatus: "none",
      joinHost: "172.16.0.94",
    });
    await db.insert(nodes).values({
      id: "playon-win-1-wsl",
      name: "win-wsl",
      os: "linux",
      docker: true,
      native: true,
      steamcmd: false,
      freeDiskBytes: 40 * 1024 ** 3,
      agentVersion: "test",
      lastSeenAt: new Date(),
      kind: "lan",
      tunnelStatus: "none",
    });
    await db.insert(nodes).values({
      id: "playon-dev",
      name: "dev",
      os: "linux",
      docker: true,
      native: true,
      steamcmd: false,
      freeDiskBytes: 20 * 1024 ** 3,
      agentVersion: "test",
      lastSeenAt: new Date(),
      kind: "lan",
      tunnelStatus: "none",
      joinHost: "172.16.0.10",
    });

    const plan = await placement.plan(skillName);
    expect(plan.recommendedNodeId).toBe("playon-dev");
    const wsl = plan.candidates.find((c) => c.nodeId === "playon-win-1-wsl");
    expect(wsl?.eligible).toBe(false);
    expect(wsl?.reasons).toContain("wsl_lan_publish_unavailable");
  });

  it("may recommend WSL when the parent advertises net_port_publish", async () => {
    nodeJobService.advertiseJobKinds("playon-win-1", ["net_port_publish"]);
    const { placement, db, skillName } = placementEnv(linuxOnlyYaml, windowsLocalProbe);
    await placement.ensureLocalNode();
    await db.insert(nodes).values({
      id: "playon-win-1",
      name: "win",
      os: "windows",
      docker: false,
      native: true,
      steamcmd: true,
      freeDiskBytes: 20 * 1024 ** 3,
      agentVersion: "test",
      lastSeenAt: new Date(),
      kind: "lan",
      tunnelStatus: "none",
      joinHost: "172.16.0.94",
    });
    await db.insert(nodes).values({
      id: "playon-win-1-wsl",
      name: "win-wsl",
      os: "linux",
      docker: true,
      native: true,
      steamcmd: false,
      freeDiskBytes: 40 * 1024 ** 3,
      agentVersion: "test",
      lastSeenAt: new Date(),
      kind: "lan",
      tunnelStatus: "none",
    });

    const plan = await placement.plan(skillName);
    expect(plan.recommendedNodeId).toBe("playon-win-1-wsl");
    const wsl = plan.candidates.find((c) => c.nodeId === "playon-win-1-wsl");
    expect(wsl?.eligible).toBe(true);
    expect(wsl?.reasons).toContain("wsl_lan_publishable");
  });

  it("does not attach Home suggestBind as port_ok for a remote recommended node", async () => {
    const net = {
      suggestBind: async () => ({ host: "0.0.0.0", port: 25566, available: true }),
    } as unknown as NetToolsService;
    const { placement, db, skillName } = placementEnv(linuxOnlyYaml, windowsLocalProbe, net);
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

    const plan = await placement.plan(skillName);
    expect(plan.recommendedNodeId).toBe("lab-linux");
    const remote = plan.candidates.find((c) => c.nodeId === "lab-linux");
    expect(remote?.reasons.some((r) => r.startsWith("port_ok:"))).toBe(false);
    expect(remote?.reasons).not.toContain("port_ok:25566");
  });

  it("places a Windows-container skill on a remote Windows docker node", async () => {
    const yaml = `
name: fixtures.linux-only-demo
version: 1.0.0
description: windows container
os: [windows]
arch: [amd64]
containerSupport: full
dockerImage: har0x/sbox-server:latest
ports:
  - name: game
    protocol: udp
    default: 27015
`;
    const { placement, db, skillName } = placementEnv(yaml, windowsLocalProbe);
    await placement.ensureLocalNode();
    await db.insert(nodes).values({
      id: "playon-win-1",
      name: "win",
      os: "windows",
      docker: true,
      native: true,
      steamcmd: true,
      freeDiskBytes: 20 * 1024 ** 3,
      agentVersion: "test",
      lastSeenAt: new Date(),
      kind: "lan",
      tunnelStatus: "none",
    });

    await expect(placement.resolveNodeId(skillName)).resolves.toBe("playon-win-1");
  });
});
