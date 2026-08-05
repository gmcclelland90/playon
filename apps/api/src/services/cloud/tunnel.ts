/**
 * WireGuard LAN-presence tunnel for Cloud nodes (design-docs/14).
 */
import { eq } from "drizzle-orm";
import {
  CLOUD_OVERLAY_HOME_IP,
  CLOUD_WG_INTERFACE,
  type NodeTunnelStatus,
} from "@playon/shared";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { nodes } from "../../db/schema.js";
import { decryptSecret, encryptSecret } from "../secrets.js";
import {
  DEFAULT_NODE_SETTINGS,
  getSetting,
  NODE_SETTINGS_KEY,
  setSetting,
  WG_HOME_SETTINGS_KEY,
  type NodeSettings,
  type WgHomeSettings,
} from "../settings.js";
import {
  defaultWgInterface,
  defaultWgListenPort,
  generateWgKeypair,
  homeOverlayCidr,
  HostWireGuardRunner,
  MemoryWireGuardRunner,
  overlayIpForHost,
  type WireGuardRunner,
  type WgPeerConfig,
  wgPublicFromPrivate,
} from "./wireguard.js";

export type TunnelStatus = NodeTunnelStatus;

export interface CloudTunnelPlan {
  nodeId: string;
  /** Join address shown on the player panel (LAN-facing). */
  advertiseHost: string;
  status: TunnelStatus;
  overlayIp?: string;
  detail?: string;
}

export type CloudPeerMaterial = {
  nodeId: string;
  overlayIp: string;
  privateKey: string;
  publicKey: string;
  /** VPS public host (no port) for Endpoint. */
  endpointHost: string;
  listenPort: number;
};

/** Record intent to bring a cloud node onto the LAN overlay (legacy helper). */
export function planCloudTunnel(opts: {
  nodeId: string;
  advertiseHost: string;
}): CloudTunnelPlan {
  return {
    nodeId: opts.nodeId,
    advertiseHost: opts.advertiseHost,
    status: "unconfigured",
    detail: "use TunnelService.ensureHomeKeys + syncHomeInterface",
  };
}

export class TunnelService {
  private readonly runner: WireGuardRunner;

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    runner?: WireGuardRunner,
  ) {
    this.runner =
      runner ??
      (process.env.PLAYON_WG_MEMORY === "1"
        ? new MemoryWireGuardRunner()
        : new HostWireGuardRunner(config.dataRoot));
  }

  getRunner(): WireGuardRunner {
    return this.runner;
  }

  toolsAvailable(): boolean {
    return this.runner.available();
  }

  async ensureHomeKeys(): Promise<{ publicKey: string; privateKey: string }> {
    const stored = await getSetting<WgHomeSettings>(this.db, WG_HOME_SETTINGS_KEY);
    if (stored?.privateKeyEncrypted && stored.publicKey) {
      return {
        publicKey: stored.publicKey,
        privateKey: decryptSecret(this.config.sessionSecret, stored.privateKeyEncrypted),
      };
    }
    const pair = generateWgKeypair();
    await setSetting(this.db, WG_HOME_SETTINGS_KEY, {
      publicKey: pair.publicKey,
      privateKeyEncrypted: encryptSecret(this.config.sessionSecret, pair.privateKey),
    } satisfies WgHomeSettings);
    return pair;
  }

  async allocateOverlayIp(): Promise<string> {
    const settings =
      (await getSetting<NodeSettings>(this.db, NODE_SETTINGS_KEY)) ?? DEFAULT_NODE_SETTINGS;
    let host = settings.nextOverlayHost ?? 2;
    const rows = await this.db.select().from(nodes);
    const used = new Set(rows.map((r) => r.overlayIp).filter(Boolean));
    while (host <= 254) {
      const ip = overlayIpForHost(host);
      host += 1;
      if (!used.has(ip)) {
        await setSetting(this.db, NODE_SETTINGS_KEY, {
          ...DEFAULT_NODE_SETTINGS,
          ...settings,
          nextOverlayHost: host,
        } satisfies NodeSettings);
        return ip;
      }
    }
    throw new Error("overlay_ip_exhausted");
  }

  async createCloudPeer(opts: {
    nodeId: string;
    endpointHost: string;
    listenPort?: number;
  }): Promise<CloudPeerMaterial> {
    const listenPort = opts.listenPort ?? defaultWgListenPort();
    const overlayIp = await this.allocateOverlayIp();
    const pair = generateWgKeypair();
    await this.db
      .update(nodes)
      .set({
        kind: "cloud",
        overlayIp,
        wgPublicKey: pair.publicKey,
        wgPrivateKeyEncrypted: encryptSecret(this.config.sessionSecret, pair.privateKey),
        tunnelEndpoint: `${opts.endpointHost}:${listenPort}`,
        tunnelStatus: "pending",
      })
      .where(eq(nodes.id, opts.nodeId));

    return {
      nodeId: opts.nodeId,
      overlayIp,
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      endpointHost: opts.endpointHost,
      listenPort,
    };
  }

  /** Rebuild Home WG interface from all cloud peers in DB. */
  async syncHomeInterface(): Promise<CloudTunnelPlan[]> {
    if (!this.runner.available()) {
      const cloud = await this.db.select().from(nodes);
      return cloud
        .filter((n) => n.kind === "cloud")
        .map((n) => ({
          nodeId: n.id,
          advertiseHost: this.config.advertiseHost,
          status: "unconfigured" as const,
          overlayIp: n.overlayIp ?? undefined,
          detail: "wireguard_tools_missing",
        }));
    }

    const home = await this.ensureHomeKeys();
    const rows = await this.db.select().from(nodes);
    const peers: WgPeerConfig[] = [];
    const plans: CloudTunnelPlan[] = [];

    for (const n of rows) {
      if (n.kind !== "cloud" || !n.wgPublicKey || !n.overlayIp) continue;
      peers.push({
        publicKey: n.wgPublicKey,
        allowedIps: `${n.overlayIp}/32`,
        endpoint: n.tunnelEndpoint ?? undefined,
        persistentKeepalive: 25,
      });
      plans.push({
        nodeId: n.id,
        advertiseHost: this.config.advertiseHost,
        status: "pending",
        overlayIp: n.overlayIp,
      });
    }

    await this.runner.apply(defaultWgInterface(), {
      privateKey: home.privateKey,
      address: homeOverlayCidr(),
      peers,
    });

    for (const plan of plans) {
      plan.status = "up";
      await this.db
        .update(nodes)
        .set({ tunnelStatus: "up" })
        .where(eq(nodes.id, plan.nodeId));
    }
    return plans;
  }

  async removeCloudPeer(nodeId: string): Promise<void> {
    await this.db
      .update(nodes)
      .set({
        tunnelStatus: "none",
        tunnelEndpoint: null,
        overlayIp: null,
        wgPublicKey: null,
        wgPrivateKeyEncrypted: null,
      })
      .where(eq(nodes.id, nodeId));
    await this.syncHomeInterface();
    const remaining = (await this.db.select().from(nodes)).filter((n) => n.kind === "cloud");
    if (remaining.length === 0) {
      await this.runner.down(CLOUD_WG_INTERFACE);
    }
  }

  async markTunnelStatus(nodeId: string, status: NodeTunnelStatus, detail?: string): Promise<void> {
    await this.db.update(nodes).set({ tunnelStatus: status }).where(eq(nodes.id, nodeId));
    void detail;
  }

  homeOverlayIp(): string {
    return CLOUD_OVERLAY_HOME_IP;
  }

  /** Config body to place on the VPS (server listens; Home is a roaming peer). */
  async remoteWgQuickConfig(peer: CloudPeerMaterial): Promise<string> {
    const home = await this.ensureHomeKeys();
    const lines = [
      "[Interface]",
      `PrivateKey = ${peer.privateKey}`,
      `Address = ${peer.overlayIp}/24`,
      `ListenPort = ${peer.listenPort}`,
      "",
      "[Peer]",
      `PublicKey = ${home.publicKey}`,
      `AllowedIPs = ${CLOUD_OVERLAY_HOME_IP}/32`,
      "",
    ];
    return lines.join("\n");
  }

  verifyStoredPublic(privateKey: string, publicKey: string): boolean {
    try {
      return wgPublicFromPrivate(privateKey) === publicKey;
    } catch {
      return false;
    }
  }
}
