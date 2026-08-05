import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "../../db/client.js";
import { applyBootstrap } from "../../db/migrate.js";
import type { AppConfig } from "../../config.js";
import { nodes } from "../../db/schema.js";
import { TunnelService } from "./tunnel.js";
import { MemoryWireGuardRunner } from "./wireguard.js";

const roots: string[] = [];

function tempConfig(): { config: AppConfig; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-tunnel-"));
  roots.push(root);
  const dbPath = path.join(root, "playon.db");
  applyBootstrap(dbPath);
  const config: AppConfig = {
    port: 8787,
    dataRoot: root,
    dbPath,
    sessionSecret: "tunnel-test-secret-at-least-32-chars!!",
    llmMode: "openai_compatible",
    runtimeMode: "native",
    advertiseHost: "192.168.1.10",
    nodeToken: "node-token",
    skillsRoots: [],
  };
  return { config, root };
}

describe("TunnelService", () => {
  afterEach(() => {
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });

  it("allocates overlay peers and syncs home interface", async () => {
    const { config } = tempConfig();
    const { db, sqlite } = createDb(config.dbPath);
    const runner = new MemoryWireGuardRunner();
    const tunnel = new TunnelService(db, config, runner);

    await db.insert(nodes).values({
      id: "vps-1",
      name: "vps-1",
      os: "linux",
      docker: true,
      native: true,
      steamcmd: false,
      freeDiskBytes: null,
      agentVersion: "pending",
      lastSeenAt: new Date(),
      kind: "cloud",
      tunnelStatus: "pending",
    });

    const peer = await tunnel.createCloudPeer({
      nodeId: "vps-1",
      endpointHost: "203.0.113.9",
    });
    expect(peer.overlayIp).toBe("10.77.0.2");
    const plans = await tunnel.syncHomeInterface();
    expect(plans[0]?.status).toBe("up");
    expect(runner.configs.get("playon0")?.peers[0]?.endpoint).toBe("203.0.113.9:51820");

    const remoteConf = await tunnel.remoteWgQuickConfig(peer);
    expect(remoteConf).toContain(`Address = ${peer.overlayIp}/24`);
    expect(remoteConf).toContain("ListenPort = 51820");
    sqlite.close();
  });
});
