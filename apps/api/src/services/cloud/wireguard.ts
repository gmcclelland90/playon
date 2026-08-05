import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLOUD_OVERLAY_HOME_IP,
  CLOUD_WG_INTERFACE,
  CLOUD_WG_LISTEN_PORT,
} from "@playon/shared";

export type WgPeerConfig = {
  /** Peer public key (base64). */
  publicKey: string;
  /** Allowed IPs for this peer, e.g. 10.77.0.5/32 */
  allowedIps: string;
  /** Optional endpoint host:port (cloud VPS). */
  endpoint?: string;
  persistentKeepalive?: number;
};

export type WgInterfaceConfig = {
  privateKey: string;
  address: string;
  listenPort?: number;
  peers: WgPeerConfig[];
};

export interface WireGuardRunner {
  /** Apply full interface config (idempotent best-effort). */
  apply(iface: string, config: WgInterfaceConfig): Promise<void>;
  /** Remove interface if present. */
  down(iface: string): Promise<void>;
  /** Whether wg tools appear available on this host. */
  available(): boolean;
}

/** Generate a WireGuard-compatible Curve25519 keypair (base64). */
export function generateWgKeypair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const privDer = privateKey.export({ type: "pkcs8", format: "der" });
  // PKCS8 for X25519: last 32 bytes are the raw key.
  const privRaw = privDer.subarray(privDer.length - 32);
  const pubDer = publicKey.export({ type: "spki", format: "der" });
  const pubRaw = pubDer.subarray(pubDer.length - 32);
  return {
    privateKey: privRaw.toString("base64"),
    publicKey: pubRaw.toString("base64"),
  };
}

/** Derive WireGuard public key from a base64 private key. */
export function wgPublicFromPrivate(privateKeyB64: string): string {
  const raw = Buffer.from(privateKeyB64, "base64");
  if (raw.length !== 32) throw new Error("wg_private_key_invalid");
  // Build minimal PKCS8 for X25519
  const pkcs8Prefix = Buffer.from("302e020100300506032b656e04220420", "hex");
  const pkcs8 = Buffer.concat([pkcs8Prefix, raw]);
  const key = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const pub = createPublicKey(key);
  const pubDer = pub.export({ type: "spki", format: "der" }) as Buffer;
  return pubDer.subarray(pubDer.length - 32).toString("base64");
}

export function renderWgQuickConfig(config: WgInterfaceConfig): string {
  const lines = [
    "[Interface]",
    `PrivateKey = ${config.privateKey}`,
    `Address = ${config.address}`,
  ];
  if (config.listenPort != null) {
    lines.push(`ListenPort = ${config.listenPort}`);
  }
  for (const peer of config.peers) {
    lines.push("");
    lines.push("[Peer]");
    lines.push(`PublicKey = ${peer.publicKey}`);
    lines.push(`AllowedIPs = ${peer.allowedIps}`);
    if (peer.endpoint) lines.push(`Endpoint = ${peer.endpoint}`);
    if (peer.persistentKeepalive != null) {
      lines.push(`PersistentKeepalive = ${peer.persistentKeepalive}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function overlayIpForHost(hostOctet: number): string {
  if (hostOctet < 2 || hostOctet > 254) throw new Error("overlay_host_out_of_range");
  return `10.77.0.${hostOctet}`;
}

export function homeOverlayCidr(): string {
  return `${CLOUD_OVERLAY_HOME_IP}/24`;
}

/** In-memory runner for unit tests — records configs, never touches the OS. */
export class MemoryWireGuardRunner implements WireGuardRunner {
  configs = new Map<string, WgInterfaceConfig>();
  private _available = true;

  setAvailable(v: boolean) {
    this._available = v;
  }

  available(): boolean {
    return this._available;
  }

  async apply(iface: string, config: WgInterfaceConfig): Promise<void> {
    this.configs.set(iface, structuredClone(config));
  }

  async down(iface: string): Promise<void> {
    this.configs.delete(iface);
  }
}

/**
 * Host WireGuard via wg-quick (Linux) or wireguard.exe conf (Windows).
 * Writes conf under dataRoot/wireguard/ and brings the interface up.
 */
export class HostWireGuardRunner implements WireGuardRunner {
  constructor(private readonly dataRoot: string) {}

  available(): boolean {
    try {
      if (process.platform === "win32") {
        execFileSync("where", ["wireguard"], { stdio: "ignore" });
        return true;
      }
      execFileSync("sh", ["-c", "command -v wg-quick"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  confPath(iface: string): string {
    return path.join(this.dataRoot, "wireguard", `${iface}.conf`);
  }

  async apply(iface: string, config: WgInterfaceConfig): Promise<void> {
    const confDir = path.join(this.dataRoot, "wireguard");
    fs.mkdirSync(confDir, { recursive: true });
    const conf = this.confPath(iface);
    const body = renderWgQuickConfig(config);
    fs.writeFileSync(conf, body, { mode: 0o600 });

    if (process.platform === "win32") {
      // Install/update tunnel from conf; WireGuard for Windows manages the service name.
      try {
        execFileSync("wireguard", ["/uninstalltunnelservice", iface], { stdio: "ignore" });
      } catch {
        // may not exist yet
      }
      execFileSync("wireguard", ["/installtunnelservice", conf], { stdio: "pipe" });
      return;
    }

    // Linux: copy into /etc/wireguard when possible, else wg-quick with conf path.
    const systemConf = `/etc/wireguard/${iface}.conf`;
    try {
      fs.copyFileSync(conf, systemConf);
      fs.chmodSync(systemConf, 0o600);
      try {
        execFileSync("wg-quick", ["down", iface], { stdio: "ignore" });
      } catch {
        // not up
      }
      execFileSync("wg-quick", ["up", iface], { stdio: "pipe" });
    } catch {
      // Non-root / no /etc — best-effort userspace note for lab
      try {
        execFileSync("wg-quick", ["down", conf], { stdio: "ignore" });
      } catch {
        // ignore
      }
      execFileSync("wg-quick", ["up", conf], { stdio: "pipe" });
    }
  }

  async down(iface: string): Promise<void> {
    const conf = this.confPath(iface);
    if (process.platform === "win32") {
      try {
        execFileSync("wireguard", ["/uninstalltunnelservice", iface], { stdio: "ignore" });
      } catch {
        // ignore
      }
      return;
    }
    try {
      execFileSync("wg-quick", ["down", iface], { stdio: "ignore" });
    } catch {
      try {
        execFileSync("wg-quick", ["down", conf], { stdio: "ignore" });
      } catch {
        // ignore
      }
    }
  }
}

export function defaultWgListenPort(): number {
  return CLOUD_WG_LISTEN_PORT;
}

export function defaultWgInterface(): string {
  return CLOUD_WG_INTERFACE;
}

export function tmpKeyPath(): string {
  return path.join(os.tmpdir(), `playon-wg-${process.pid}`);
}
